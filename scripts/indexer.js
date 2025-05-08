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
      royalty_amount TEXT,
      FOREIGN KEY(repository, software_id) REFERENCES software_publications(repository, software_id)
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

    // Check if we've already processed this event
    const eventId = `${event.transactionHash}-${event.logIndex}`;
    if (isEventProcessed(eventId)) return;

    // Add to database
    try {
      const stmt = db.prepare(`
        INSERT INTO software_publications
        (id, repository, software_id, publish_time, block_number, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        `${repository}-${softwareId.toString()}`,
        repository,
        softwareId.toString(),
        publishTime.toString(),
        event.blockNumber,
        Math.floor(Date.now() / 1000)
      );

      // Mark as processed
      markEventProcessed(eventId);
      console.log('Software publication recorded in database');
    } catch (error) {
      console.error('Error recording software publication:', error);
    }
  });

  royaltyManager.on('SaleMade', async (repository, softwareId, price, timestamp, event) => {
    console.log(`Sale made: ${repository} - ID: ${softwareId} - Price: ${ethers.utils.formatEther(price)} ETH`);

    // Check if we've already processed this event
    const eventId = `${event.transactionHash}-${event.logIndex}`;
    if (isEventProcessed(eventId)) return;

    try {
      // Extract developer from event args (adjust based on your event structure)
      const developer = event.args[0]; // This should be properly extracted

      // Get buyer from transaction
      const tx = await event.getTransaction();
      const buyer = tx.from;

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
        timestamp.toString(),
        buyer,
        developer,
        event.blockNumber
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

// Add these new functions to handle recursive dependency analysis

// Function to analyze and store the complete dependency tree for a software
async function analyzeDependencyTree(repository, softwareId, depth = 0, visitedNodes = new Set()) {
  try {
    // Create a unique ID for this software to prevent cycles
    const nodeId = `${repository}-${softwareId}`;

    // Skip if we've seen this node before (prevent infinite recursion)
    if (visitedNodes.has(nodeId)) return;
    visitedNodes.add(nodeId);

    // Get contract instances
    const Repository = await ethers.getContractFactory('Repository');
    const repoInstance = await Repository.attach(repository);

    // Get immediate dependencies of this software
    const [dependencies, depTokenIds] = await repoInstance.getSoftwareDependencies(softwareId);

    // No dependencies? We're done with this branch
    if (dependencies.length === 0) return;

    // Store dependency relationships in database
    const insertDepStmt = db.prepare(`
      INSERT OR IGNORE INTO dependency_relationships (
        repository, software_id, depends_on_repository, depends_on_software_id, dependency_depth
      ) VALUES (?, ?, ?, ?, ?)
    `);

    // For each direct dependency
    for (let i = 0; i < dependencies.length; i++) {
      const depRepo = dependencies[i];
      for (let j = 0; j < depTokenIds[i].length; j++) {
        const depTokenId = depTokenIds[i][j].toString();

        // Store this direct dependency relationship
        insertDepStmt.run(
          repository,
          softwareId.toString(),
          depRepo,
          depTokenId,
          depth + 1  // Level 1 dependencies are depth 1
        );

        console.log(`Stored dependency: ${repository}-${softwareId} → ${depRepo}-${depTokenId} (depth ${depth + 1})`);

        // Recursively analyze this dependency's dependencies
        await analyzeDependencyTree(depRepo, depTokenId, depth + 1, visitedNodes);

        // Now store indirect dependency relationships
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

          console.log(`Stored indirect dependency: ${repository}-${softwareId} → ${indirect.depends_on_repository}-${indirect.depends_on_software_id} (depth ${depth + 1 + indirect.dependency_depth})`);
        }
      }
    }
  } catch (error) {
    console.error(`Error analyzing dependency tree for ${repository}-${softwareId}:`, error);
  }
}

// Calculate royalties with decay based on dependency depth
function calculateRoyaltyByDepth(price, depth, parameters) {
  // Default parameters if none found
  const {
    initialRate = 10,    // Base royalty percentage for direct author
    decayFactor = 65,    // How much to reduce royalty per depth level (35% reduction per level)
    maxDepth = 5         // Maximum dependency depth to consider
  } = parameters;

  // Apply depth-based decay (depth 0 is the direct author)
  let currentRate = initialRate;
  for (let i = 0; i < Math.min(depth, maxDepth); i++) {
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

    // Make sure we have analyzed the dependency tree
    await analyzeDependencyTree(repository, softwareId);

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
