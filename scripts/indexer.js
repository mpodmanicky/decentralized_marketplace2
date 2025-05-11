const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Initialize SQLite database
const DB_PATH = path.join(__dirname, '../indexer.db');
const db = new Database(DB_PATH);

// Initialize database schema
function initDB() {
  // Enable foreign keys for integrity
  db.pragma('foreign_keys = ON');

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS royalty_parameters (
      id TEXT PRIMARY KEY,
      initial_rate INTEGER NOT NULL,
      decay_factor INTEGER NOT NULL,
      decay_period INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      block_number INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS software_publications (
      id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      software_id TEXT NOT NULL,
      publish_time INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      developer TEXT,
      UNIQUE(repository, software_id)
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      software_id TEXT NOT NULL,
      price TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      buyer TEXT NOT NULL,
      developer TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      processed BOOLEAN NOT NULL DEFAULT 0,
      royalty_amount TEXT
      /* Removing the foreign key constraint to allow sales to be recorded
         even if the software hasn't been indexed yet */
      /* FOREIGN KEY(repository, software_id) REFERENCES software_publications(repository, software_id) */
    );

    CREATE TABLE IF NOT EXISTS pending_royalties (
      developer TEXT PRIMARY KEY,
      amount TEXT NOT NULL,
      last_updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dependency_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository TEXT NOT NULL,
      software_id TEXT NOT NULL,
      depends_on_repository TEXT NOT NULL,
      depends_on_software_id TEXT NOT NULL,
      dependency_depth INTEGER NOT NULL,
      UNIQUE(repository, software_id, depends_on_repository, depends_on_software_id)
    );

    CREATE TABLE IF NOT EXISTS dependency_royalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id TEXT NOT NULL,
      developer TEXT NOT NULL,
      repository TEXT NOT NULL,
      software_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      depth INTEGER NOT NULL,
      rate REAL NOT NULL,
      FOREIGN KEY(sale_id) REFERENCES sales(id)
    );

    CREATE TABLE IF NOT EXISTS dependent_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository TEXT NOT NULL,
      software_id TEXT NOT NULL,
      depended_on_by_repository TEXT NOT NULL,
      depended_on_by_software_id TEXT NOT NULL,
      UNIQUE(repository, software_id, depended_on_by_repository, depended_on_by_software_id)
    );
  `);

  console.log('Database initialized with dependency tracking tables');
}

// Check if event has been processed
function isEventProcessed(eventId) {
  const stmt = db.prepare('SELECT id FROM processed_events WHERE id = ?');
  return !!stmt.get(eventId);
}

// Mark event as processed
function markEventProcessed(eventId) {
  const stmt = db.prepare('INSERT OR REPLACE INTO processed_events (id, timestamp) VALUES (?, ?)');
  stmt.run(eventId, Math.floor(Date.now() / 1000));
}

// Calculate royalties with exponential decay
function calculateRoyalty(price, publishTime, currentTime, parameters) {
  // Default parameters if none found
  const {
    initialRate = 10,
    decayFactor = 95,
    decayPeriod = 30 * 24 * 60 * 60 // 30 days in seconds
  } = parameters;

  // Calculate time elapsed since publication
  const timeElapsed = currentTime - publishTime;

  // Calculate number of decay periods
  const periods = Math.floor(timeElapsed / decayPeriod);

  // Calculate decay factor
  let currentRate = initialRate;
  for (let i = 0; i < periods; i++) {
    currentRate = (currentRate * decayFactor) / 100;
  }

  // Ensure minimum royalty of 1%
  currentRate = Math.max(currentRate, 1);

  // Calculate royalty amount (using BigNumber for precision)
  const priceValue = ethers.BigNumber.from(price);
  const royalty = priceValue.mul(currentRate).div(100);

  return royalty.toString();
}

async function startIndexer() {
  // Initialize database
  initDB();

  // Get contract instances
  const Registry = await ethers.getContractFactory('Registry');
  const registry = await Registry.attach(process.env.REGISTRY_ADDRESS || '0x5FbDB2315678afecb367f032d93F642f64180aa3');  // Pass your registry address

  const royaltyManagerAddress = await registry.getRoyaltyManager();
  console.log('RoyaltyManager address:', royaltyManagerAddress);

  const RoyaltyManager = await ethers.getContractFactory('RoyaltyManager');
  const royaltyManager = await RoyaltyManager.attach(royaltyManagerAddress);

  // Set up event listeners
  royaltyManager.on('SoftwarePublished', async (repository, softwareId, publishTime, event) => {
    console.log(`Software published: ${repository} - ID: ${softwareId}`);

    // Generate a unique ID - handle case when event object is incomplete
    let eventId;
    try {
      eventId = `${event.transactionHash}-${event.logIndex}`;
    } catch (error) {
      // Fallback to a timestamp-based ID if event properties are missing
      eventId = `pub-${repository}-${softwareId}-${Date.now()}`;
      console.log(`Warning: Incomplete event object, using generated ID: ${eventId}`);
    }

    // Check if we've already processed this event
    if (isEventProcessed(eventId)) return;

    // Add to database
    try {
      // Get the developer (owner of the software NFT)
      const Repository = await ethers.getContractFactory('Repository');
      const repoInstance = await Repository.attach(repository);

      let developer;
      try {
        developer = await repoInstance.ownerOf(softwareId);
      } catch (err) {
        console.error(`Error getting software owner: ${err.message}`);
        developer = 'unknown';
      }

      // Get block number safely
      const blockNumber = event && event.blockNumber ? event.blockNumber : 0;

      // Insert into database
      const stmt = db.prepare(`
        INSERT INTO software_publications
        (id, repository, software_id, publish_time, block_number, timestamp, developer)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        `${repository}-${softwareId.toString()}`,
        repository,
        softwareId.toString(),
        publishTime.toString(),
        blockNumber,
        Math.floor(Date.now() / 1000),
        developer
      );

      // Mark as processed
      markEventProcessed(eventId);
      console.log(`Software publication recorded in database for developer ${developer}`);

      // Immediately analyze dependencies using ERC-5521 mechanisms
      console.log("Analyzing dependency relationships using ERC-5521...");

      // First verify ERC_5521 support
      const hasERC5521Support = await verifyERC5521Support(repository);

      // Analyze dependencies
      if (hasERC5521Support) {
        const dependencyResult = await analyzeDependencyTree(repository, softwareId);
        console.log(`Indexed ${dependencyResult.directDependencyCount} direct dependencies`);

        // Also analyze reverse dependencies (what depends on this)
        const dependentResult = await analyzeDependents(repository, softwareId);
        console.log(`Indexed ${dependentResult.directDependentCount} direct dependents`);
      } else {
        console.log(`Repository ${repository} does not fully support ERC_5521, using fallback methods`);
        // Use fallback method in analyzeDependencyTree
        await analyzeDependencyTree(repository, softwareId);
      }
    } catch (error) {
      console.error('Error recording software publication:', error);
    }
  });

  // Replace the SaleMade event handler with this updated version
  royaltyManager.on('SaleMade', async (repository, softwareId, price, timestamp, event) => {
    console.log(`Sale made: ${repository} - ID: ${softwareId} - Price: ${ethers.utils.formatEther(price)} ETH`);

    // Generate a unique ID - handle case when event object is incomplete
    let eventId;
    try {
      eventId = `${event.transactionHash}-${event.logIndex}`;
    } catch (error) {
      // Fallback to a timestamp-based ID if event properties are missing
      eventId = `sale-${repository}-${softwareId}-${Date.now()}`;
      console.log(`Warning: Incomplete event object, using generated ID: ${eventId}`);
    }

    // Check if we've already processed this event
    if (isEventProcessed(eventId)) return;

    try {
      // Get transaction details to extract buyer and developer
      let buyer = 'unknown';
      let developer = 'unknown';

      // Get the developer (owner of the software NFT)
      try {
        const Repository = await ethers.getContractFactory('Repository');
        const repoInstance = await Repository.attach(repository);
        developer = await repoInstance.ownerOf(softwareId);
      } catch (err) {
        console.error(`Error getting software owner: ${err.message}`);
      }

      // Try to get the buyer from transaction logs
      try {
        if (event && event.getTransaction) {
          const tx = await event.getTransaction();
          buyer = tx.from;
        }
      } catch (txError) {
        console.log('Could not get transaction details:', txError.message);
      }

      // First, check if we have a publication record, if not, create one
      const pubCheck = db.prepare(
        'SELECT id FROM software_publications WHERE repository = ? AND software_id = ?'
      );
      const pubExists = pubCheck.get(repository, softwareId.toString());

      if (!pubExists) {
        console.log(`No publication record found for ${repository}-${softwareId}, creating one`);

        // Create a placeholder publication record
        const pubStmt = db.prepare(`
          INSERT OR IGNORE INTO software_publications
          (id, repository, software_id, publish_time, block_number, timestamp, developer)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const blockNumber = event && event.blockNumber ? event.blockNumber : 0;

        pubStmt.run(
          `${repository}-${softwareId.toString()}`,
          repository,
          softwareId.toString(),
          currentTimestamp, // Use current time as placeholder
          blockNumber,
          currentTimestamp,
          developer
        );

        console.log(`Created placeholder publication record for ${repository}-${softwareId}`);
      }

      // Get block number safely
      const blockNumber = event && event.blockNumber ? event.blockNumber : 0;

      // Add sale to database
      const stmt = db.prepare(`
        INSERT INTO sales
        (id, repository, software_id, price, timestamp, buyer, developer, block_number, processed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);

      stmt.run(
        eventId,
        repository,
        softwareId.toString(),
        price.toString(),
        Math.floor(Date.now() / 1000),
        buyer,
        developer,
        blockNumber
      );

      // Mark event as processed
      markEventProcessed(eventId);
      console.log('Sale recorded in database');

      // Trigger royalty calculation
      calculateRoyalties();
    } catch (error) {
      console.error('Error recording sale:', error);
    }
  });

  royaltyManager.on('RoyaltyParametersUpdated', (initialRate, decayFactor, decayPeriod, event) => {
    console.log(`Royalty parameters updated: ${initialRate}% initial, ${decayFactor}% decay, ${decayPeriod} seconds period`);

    // Check if we've already processed this event
    const eventId = `${event.transactionHash}-${event.logIndex}`;
    if (isEventProcessed(eventId)) return;

    try {
      // Add to database
      const stmt = db.prepare(`
        INSERT INTO royalty_parameters
        (id, initial_rate, decay_factor, decay_period, timestamp, block_number)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        eventId,
        initialRate.toString(),
        decayFactor.toString(),
        decayPeriod.toString(),
        Math.floor(Date.now() / 1000),
        event.blockNumber
      );

      // Mark as processed
      markEventProcessed(eventId);
      console.log('Royalty parameters recorded in database');
    } catch (error) {
      console.error('Error recording royalty parameters:', error);
    }
  });

  console.log('Indexer started. Listening for events...');
}

// Calculate royalties for unprocessed sales
function calculateRoyalties() {
  console.log('Calculating royalties for unprocessed sales...');

  try {
    // Get unprocessed sales
    const salesStmt = db.prepare(`
      SELECT s.id, s.repository, s.software_id, s.price
      FROM sales s
      WHERE s.processed = 0
    `);

    const unprocessedSales = salesStmt.all();
    console.log(`Found ${unprocessedSales.length} unprocessed sales`);

    // Process each sale with dependency-based royalties
    for (const sale of unprocessedSales) {
      calculateDependencyRoyalties(
        sale.id,
        sale.repository,
        parseInt(sale.software_id),
        sale.price
      ).then((result) => {
        console.log(`Processed royalties for sale ${sale.id}: ${ethers.utils.formatEther(result.totalRoyalty)} ETH distributed to ${result.depCount + 1} developers`);
      }).catch(error => {
        console.error(`Error processing sale ${sale.id}:`, error);
      });
    }
  } catch (error) {
    console.error('Error calculating royalties:', error);
  }
}

// Add a simple HTTP server to check royalties
const http = require('http');
function startServer() {
  const server = http.createServer((req, res) => {
    try {
      if (req.url.startsWith('/api/royalties/')) {
        const developer = req.url.substring('/api/royalties/'.length);

        // Get pending royalties
        const pendingStmt = db.prepare(`
          SELECT amount FROM pending_royalties WHERE developer = ?
        `);
        const pending = pendingStmt.get(developer);

        // Get sales
        const salesStmt = db.prepare(`
          SELECT id, repository, software_id, price, timestamp, royalty_amount
          FROM sales
          WHERE developer = ?
          ORDER BY timestamp DESC
        `);
        const sales = salesStmt.all(developer);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          pending: pending ? pending.amount : '0',
          sales: sales
        }));
      } else if (req.url === '/api/sales') {
        const salesStmt = db.prepare(`
          SELECT * FROM sales ORDER BY timestamp DESC
        `);
        const sales = salesStmt.all();

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(sales));
      } else if (req.url === '/api/publications') {
        const pubStmt = db.prepare(`
          SELECT * FROM software_publications ORDER BY publish_time DESC
        `);
        const publications = pubStmt.all();

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(publications));
      } else if (req.url === '/api/parameters') {
        const paramsStmt = db.prepare(`
          SELECT * FROM royalty_parameters ORDER BY timestamp DESC LIMIT 1
        `);
        const params = paramsStmt.get();

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(params || { initialRate: 10, decayFactor: 95, decayPeriod: 30 * 24 * 60 * 60 }));
      } else if (req.url.startsWith('/api/dependencies/')) {
        const [repo, softwareId] = req.url.substring('/api/dependencies/'.length).split('/');

        if (!repo || !softwareId) {
          res.statusCode = 400;
          res.end('Bad Request: Need repository and software ID');
          return;
        }

        // Get all dependencies with their developers and depths
        const depStmt = db.prepare(`
          SELECT
            d.depends_on_repository,
            d.depends_on_software_id,
            MIN(d.dependency_depth) as depth,
            p.developer
          FROM dependency_relationships d
          LEFT JOIN software_publications p ON d.depends_on_repository = p.repository AND d.depends_on_software_id = p.software_id
          WHERE d.repository = ? AND d.software_id = ?
          GROUP BY d.depends_on_repository, d.depends_on_software_id
          ORDER BY depth ASC
        `);

        const dependencies = depStmt.all(repo, softwareId);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          repository: repo,
          softwareId: softwareId,
          dependencies: dependencies
        }));
      } else if (req.url.startsWith('/api/royaltytree/')) {
        const saleId = req.url.substring('/api/royaltytree/'.length);

        const royaltyStmt = db.prepare(`
          SELECT
            developer, repository, software_id, amount, depth, rate
          FROM dependency_royalties
          WHERE sale_id = ?
          ORDER BY depth ASC
        `);

        const royalties = royaltyStmt.all(saleId);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          saleId: saleId,
          royaltyDistribution: royalties
        }));
      } else if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(fs.readFileSync(path.join(__dirname, '../dashboard.html')));
      } else if (req.url.startsWith('/api/graph/')) {
        const [repo, softwareId] = req.url.substring('/api/graph/'.length).split('/');

        if (!repo || !softwareId) {
          res.statusCode = 400;
          res.end('Bad Request: Need repository and software ID');
          return;
        }

        // Get dependencies (what this software refers to)
        const depStmt = db.prepare(`
          SELECT
            depends_on_repository as repository,
            depends_on_software_id as software_id,
            dependency_depth as depth
          FROM dependency_relationships
          WHERE repository = ? AND software_id = ?
          ORDER BY depth ASC
        `);

        // Get dependents (what refers to this software)
        const depOnStmt = db.prepare(`
          SELECT
            depended_on_by_repository as repository,
            depended_on_by_software_id as software_id
          FROM dependent_relationships
          WHERE repository = ? AND software_id = ?
        `);

        const dependencies = depStmt.all(repo, softwareId);
        const dependents = depOnStmt.all(repo, softwareId);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          repository: repo,
          softwareId: softwareId,
          dependencies: dependencies,    // What this software depends on
          dependents: dependents         // What depends on this software
        }));
      } else if (req.url.startsWith('/api/test-erc5521/')) {
        const [repo, softwareId] = req.url.substring('/api/test-erc5521/'.length).split('/');

        if (!repo || !softwareId) {
          res.statusCode = 400;
          res.end('Bad Request: Need repository and software ID');
          return;
        }

        testERC5521Integration(repo, softwareId)
          .then(result => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result, null, 2));
          })
          .catch(error => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
          });
      } else if (req.url.startsWith('/api/royalties/dependency/')) {
        const developer = req.url.substring('/api/royalties/dependency/'.length);

        // Get all dependency royalties for this developer
        const royaltyStmt = db.prepare(`
          SELECT
            dr.sale_id,
            dr.repository,
            dr.software_id,
            dr.amount,
            dr.depth,
            dr.rate,
            s.price as sale_price,
            s.timestamp as sale_time
          FROM dependency_royalties dr
          JOIN sales s ON dr.sale_id = s.id
          WHERE dr.developer = ?
          ORDER BY s.timestamp DESC, dr.depth ASC
        `);

        const royalties = royaltyStmt.all(developer);

        // Get pending royalties
        const pendingStmt = db.prepare(`
          SELECT amount FROM pending_royalties WHERE developer = ?
        `);
        const pending = pendingStmt.get(developer);

        // Get exponential decay curve data
        const paramsStmt = db.prepare(`
          SELECT initial_rate, decay_factor FROM royalty_parameters ORDER BY timestamp DESC LIMIT 1
        `);

        let initialRate = 10;
        let decayFactor = 65;

        const params = paramsStmt.get();
        if (params) {
          initialRate = parseInt(params.initial_rate);
          decayFactor = parseInt(params.decay_factor);
        }

        // Generate decay curve
        const decayCurve = [];
        for (let depth = 0; depth <= 5; depth++) {
          let rate = initialRate;
          for (let i = 0; i < depth; i++) {
            rate = (rate * decayFactor) / 100;
          }
          decayCurve.push({
            depth,
            rate
          });
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          developer,
          pending: pending ? pending.amount : '0',
          royalties,
          decayCurve,
          parameters: {
            initialRate,
            decayFactor
          }
        }));
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
    } catch (error) {
      console.error('API error:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Indexer API running on port ${PORT}`);
  });
}

// Start both the indexer and API server
async function main() {
  await startIndexer();
  startServer();

  // Periodically check for unprocessed sales
  setInterval(calculateRoyalties, 60 * 1000); // Every minute
}

// Run the main function
main().catch(error => {
  console.error('Error in indexer:', error);
  process.exit(1);
});

// Replace the analyzeDependencyTree function with this ERC-5521-aware version

// Function to analyze and store the complete dependency tree using ERC-5521 functions
async function analyzeDependencyTree(repository, softwareId, depth = 0, visitedNodes = new Set()) {
  try {
    // Create a unique ID for this software to prevent cycles
    const nodeId = `${repository}-${softwareId}`;

    // Skip if we've seen this node before (prevent infinite recursion)
    if (visitedNodes.has(nodeId)) return;
    visitedNodes.add(nodeId);

    // Get contract instances - use ERC-5521 interface
    const ERC5521 = await ethers.getContractFactory('ERC_5521');
    const repoInstance = await ERC5521.attach(repository);

    console.log(`Analyzing dependencies for ${repository}-${softwareId} using ERC-5521 functions`);

    // Use ERC-5521's referringOf function to get all software this token refers to (dependencies)
    const [referringRepos, referringTokenIds] = await repoInstance.referringOf(repository, softwareId);

    console.log(`${repository}-${softwareId} refers to ${referringRepos.length} other repositories`);

    // No dependencies? We're done with this branch
    if (referringRepos.length === 0) return;

    // Store dependency relationships in database
    const insertDepStmt = db.prepare(`
      INSERT OR IGNORE INTO dependency_relationships (
        repository, software_id, depends_on_repository, depends_on_software_id, dependency_depth
      ) VALUES (?, ?, ?, ?, ?)
    `);

    // For each direct dependency (referring relationship)
    for (let i = 0; i < referringRepos.length; i++) {
      const depRepo = referringRepos[i];
      for (let j = 0; j < referringTokenIds[i].length; j++) {
        const depTokenId = referringTokenIds[i][j].toString();

        console.log(`Found dependency: ${repository}-${softwareId} → ${depRepo}-${depTokenId}`);

        // Store this direct dependency relationship
        insertDepStmt.run(
          repository,
          softwareId.toString(),
          depRepo,
          depTokenId,
          depth + 1  // Level 1 dependencies are depth 1
        );

        // Recursively analyze this dependency's dependencies
        await analyzeDependencyTree(depRepo, depTokenId, depth + 1, visitedNodes);

        // Now get indirect dependencies via the database
        // This avoids circular dependencies while still capturing the full graph
        const indirectDepsStmt = db.prepare(`
          SELECT depends_on_repository, depends_on_software_id, dependency_depth
          FROM dependency_relationships
          WHERE repository = ? AND software_id = ?
        `);

        const indirectDeps = indirectDepsStmt.all(depRepo, depTokenId);

        // For each indirect dependency, create a relationship from the original software
        for (const indirect of indirectDeps) {
          insertDepStmt.run(
            repository,
            softwareId.toString(),
            indirect.depends_on_repository,
            indirect.depends_on_software_id,
            depth + 1 + indirect.dependency_depth // Adjust depth based on the chain
          );
        }
      }
    }

    // We could also use referredOf to see all software that depends on this one,
    // but for dependency analysis we're primarily interested in what this software refers to.
    // We'll add a separate function for analyzing dependents.

  } catch (error) {
    console.error(`Error analyzing ERC-5521 dependency tree for ${repository}-${softwareId}:`, error);
  }
}

// Add a new function to analyze what depends on a given piece of software
async function analyzeDependents(repository, softwareId) {
  try {
    // Get contract instances
    const ERC5521 = await ethers.getContractFactory('ERC_5521');
    const repoInstance = await ERC5521.attach(repository);

    console.log(`Analyzing dependents for ${repository}-${softwareId} using ERC-5521 functions`);

    // Use ERC-5521's referredOf function to get all software that refers to this token (dependents)
    const [referredRepos, referredTokenIds] = await repoInstance.referredOf(repository, softwareId);

    console.log(`${repository}-${softwareId} is referred to by ${referredRepos.length} other repositories`);

    // Store all the dependent relationships
    const insertDepStmt = db.prepare(`
      INSERT OR IGNORE INTO dependent_relationships (
        repository, software_id, depended_on_by_repository, depended_on_by_software_id
      ) VALUES (?, ?, ?, ?)
    `);

    // For each dependent relationship
    for (let i = 0; i < referredRepos.length; i++) {
      const dependentRepo = referredRepos[i];
      for (let j = 0; j < referredTokenIds[i].length; j++) {
        const dependentTokenId = referredTokenIds[i][j].toString();

        console.log(`Found dependent: ${repository}-${softwareId} ← ${dependentRepo}-${dependentTokenId}`);

        // Store this dependent relationship
        insertDepStmt.run(
          repository,
          softwareId.toString(),
          dependentRepo,
          dependentTokenId
        );
      }
    }

    return {
      repositories: referredRepos,
      tokenIds: referredTokenIds
    };

  } catch (error) {
    console.error(`Error analyzing ERC-5521 dependents for ${repository}-${softwareId}:`, error);
    return { repositories: [], tokenIds: [] };
  }
}

// Calculate royalties with decay based on dependency depth
function calculateRoyaltyByDepth(price, depth, parameters) {
  // Default parameters if none found
  const {
    initialRate = 10,    // Base royalty percentage for direct author
    decayFactor = 65,    // How much to reduce royalty per depth level (65% means 35% reduction per level)
    maxDepth = 5         // Maximum dependency depth to consider
  } = parameters;

  // Skip calculation for depths beyond our max consideration
  if (depth > maxDepth) {
    return {
      royaltyAmount: ethers.BigNumber.from(0),
      rate: 0
    };
  }

  // Apply exponential depth-based decay (depth 0 is the direct author)
  // Formula: initialRate * (decayFactor/100)^depth
  let currentRate = initialRate;
  for (let i = 0; i < depth; i++) {
    currentRate = (currentRate * decayFactor) / 100;
  }

  // Ensure minimum royalty of 0.1%
  currentRate = Math.max(currentRate, 0.1);

  // Calculate royalty amount (using BigNumber for precision)
  const priceValue = ethers.BigNumber.from(price);
  const royalty = priceValue.mul(Math.floor(currentRate * 100)).div(10000); // Convert percentage to basis points

  return {
    royaltyAmount: royalty,
    rate: currentRate
  };
}

// Calculate royalties for dependencies up to maxDepth
async function calculateDependencyRoyalties(saleId, repository, softwareId, price) {
  try {
    // Get the latest royalty parameters
    const paramsStmt = db.prepare(`
      SELECT initial_rate, decay_factor, decay_period
      FROM royalty_parameters
      ORDER BY timestamp DESC LIMIT 1
    `);

    let params = {
      initialRate: 10,
      decayFactor: 65,  // 65% of previous level
      maxDepth: 5
    };

    const latestParams = paramsStmt.get();
    if (latestParams) {
      params = {
        initialRate: parseInt(latestParams.initial_rate),
        decayFactor: parseInt(latestParams.decay_factor),
        maxDepth: 5  // This could also come from parameters
      };
    }

    // Verify ERC_5521 support
    const hasERC5521Support = await verifyERC5521Support(repository);

    // Make sure we have analyzed the dependency tree using all available methods
    if (hasERC5521Support) {
      console.log(`Using ERC_5521 methods for dependency analysis of ${repository}-${softwareId}`);
      await analyzeDependencyTree(repository, softwareId);
      await analyzeDependents(repository, softwareId);
    } else {
      console.log(`Using fallback methods for dependency analysis of ${repository}-${softwareId}`);
      await analyzeDependencyTree(repository, softwareId);
    }

    // Start with the primary author (depth 0)
    const developerStmt = db.prepare(`
      SELECT developer FROM software_publications
      WHERE repository = ? AND software_id = ?
    `);

    const pubInfo = developerStmt.get(repository, softwareId.toString());
    if (!pubInfo) {
      throw new Error(`Publication info not found for ${repository}-${softwareId}`);
    }

    // Calculate primary author royalty
    const primaryDeveloper = pubInfo.developer;
    const primaryRoyaltyResult = calculateRoyaltyByDepth(price, 0, params);
    let reservedAmount = primaryRoyaltyResult.royaltyAmount;

    // Store this royalty in the database
    const insertRoyaltyStmt = db.prepare(`
      INSERT INTO dependency_royalties (
        sale_id, developer, repository, software_id, amount, depth, rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertRoyaltyStmt.run(
      saleId,
      primaryDeveloper,
      repository,
      softwareId.toString(),
      primaryRoyaltyResult.royaltyAmount.toString(),
      0,
      primaryRoyaltyResult.rate
    );

    // Update the pending royalties for the primary developer
    updatePendingRoyalty(primaryDeveloper, primaryRoyaltyResult.royaltyAmount.toString());

    // Get all dependencies with their depths
    const depStmt = db.prepare(`
      SELECT
        depends_on_repository,
        depends_on_software_id,
        MIN(dependency_depth) as depth
      FROM dependency_relationships
      WHERE repository = ? AND software_id = ?
      GROUP BY depends_on_repository, depends_on_software_id
    `);

    const dependencies = depStmt.all(repository, softwareId.toString());
    console.log(`Found ${dependencies.length} dependencies for ${repository}-${softwareId}`);

    // Calculate royalties for each dependency based on its depth
    for (const dep of dependencies) {
      // Get the developer of this dependency
      const depInfo = developerStmt.get(dep.depends_on_repository, dep.depends_on_software_id);
      if (!depInfo) continue;

      const depDeveloper = depInfo.developer;
      const depRoyaltyResult = calculateRoyaltyByDepth(price, dep.depth, params);

      // Store this dependency royalty
      insertRoyaltyStmt.run(
        saleId,
        depDeveloper,
        dep.depends_on_repository,
        dep.depends_on_software_id,
        depRoyaltyResult.royaltyAmount.toString(),
        dep.depth,
        depRoyaltyResult.rate
      );

      // Update pending royalties for this dependency developer
      updatePendingRoyalty(depDeveloper, depRoyaltyResult.royaltyAmount.toString());

      // Add to the reserved amount
      reservedAmount = reservedAmount.add(depRoyaltyResult.royaltyAmount);
    }

    // Update the sale record to show the total royalty amount
    const updateSaleStmt = db.prepare(`
      UPDATE sales
      SET processed = 1, royalty_amount = ?
      WHERE id = ?
    `);

    updateSaleStmt.run(reservedAmount.toString(), saleId);

    return {
      totalRoyalty: reservedAmount.toString(),
      depCount: dependencies.length
    };
  } catch (error) {
    console.error(`Error calculating dependency royalties:`, error);
    throw error;
  }
}

// Helper function to update pending royalties
function updatePendingRoyalty(developer, amount) {
  const updateStmt = db.prepare(`
    INSERT INTO pending_royalties (developer, amount, last_updated)
    VALUES (?, ?, ?)
    ON CONFLICT(developer) DO UPDATE SET
    amount = CAST(amount as DECIMAL) + CAST(? as DECIMAL),
    last_updated = ?
  `);

  const now = Math.floor(Date.now() / 1000);
  updateStmt.run(developer, amount, now, amount, now);
}

// Add this helper function to verify ERC_5521 implementation
async function verifyERC5521Support(repository) {
  try {
    const ERC5521Interface = await ethers.getContractFactory("ERC_5521");
    const repoInstance = await ERC5521Interface.attach(repository);

    // Test if contract supports ERC_5521 interface
    const supportsERC5521 = await repoInstance.supportsInterface("0x4179b1ee");
    console.log(`Repository ${repository} ERC_5521 support: ${supportsERC5521}`);

    return supportsERC5521;
  } catch (error) {
    console.error(`Error verifying ERC_5521 support for ${repository}:`, error.message);
    return false;
  }
}

// Add a function to test ERC-5521 integration that can be called via API
async function testERC5521Integration(repository, softwareId) {
  try {
    console.log(`Testing ERC-5521 integration for ${repository}-${softwareId}...`);

    // First check if contract supports the interface
    const hasSupport = await verifyERC5521Support(repository);
    console.log(`ERC-5521 interface support: ${hasSupport}`);

    // Attempt to call referringOf
    const ERC5521Interface = await ethers.getContractFactory("ERC_5521");
    const repoInstance = await ERC5521Interface.attach(repository);

    console.log('Calling referringOf...');
    const [referringRepos, referringTokenIds] = await repoInstance.referringOf(repository, softwareId);
    console.log('referringOf results:');
    console.log('- Repositories:', referringRepos);
    console.log('- Token IDs:', referringTokenIds.map(ids => ids.map(id => id.toString())));

    console.log('Calling referredOf...');
    const [referredRepos, referredTokenIds] = await repoInstance.referredOf(repository, softwareId);
    console.log('referredOf results:');
    console.log('- Repositories:', referredRepos);
    console.log('- Token IDs:', referredTokenIds.map(ids => ids.map(id.toString())));

    return {
      supportsERC5521: hasSupport,
      referringTo: {
        repositories: referringRepos,
        tokenIds: referringTokenIds.map(ids => ids.map(id => id.toString()))
      },
      referredBy: {
        repositories: referredRepos,
        tokenIds: referredTokenIds.map(ids => ids.map(id => id.toString()))
      }
    };
  } catch (error) {
    console.error(`Error testing ERC-5521 integration:`, error.message);
    return {
      supportsERC5521: false,
      error: error.message
    };
  }
}
