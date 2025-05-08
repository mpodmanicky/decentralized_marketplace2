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
  `);

  console.log('Database initialized');
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
    // Get latest royalty parameters
    const paramsStmt = db.prepare(`
      SELECT initial_rate, decay_factor, decay_period
      FROM royalty_parameters
      ORDER BY timestamp DESC LIMIT 1
    `);

    let params = { initialRate: 10, decayFactor: 95, decayPeriod: 30 * 24 * 60 * 60 };
    const latestParams = paramsStmt.get();

    if (latestParams) {
      params = {
        initialRate: parseInt(latestParams.initial_rate),
        decayFactor: parseInt(latestParams.decay_factor),
        decayPeriod: parseInt(latestParams.decay_period)
      };
    }

    // Get unprocessed sales
    const salesStmt = db.prepare(`
      SELECT s.id, s.repository, s.software_id, s.price, s.timestamp, s.developer,
             p.publish_time
      FROM sales s
      JOIN software_publications p ON s.repository = p.repository AND s.software_id = p.software_id
      WHERE s.processed = 0
    `);

    const unprocessedSales = salesStmt.all();
    console.log(`Found ${unprocessedSales.length} unprocessed sales`);

    // Process each sale
    const updateSaleStmt = db.prepare(`
      UPDATE sales
      SET processed = 1, royalty_amount = ?
      WHERE id = ?
    `);

    const updateRoyaltyStmt = db.prepare(`
      INSERT INTO pending_royalties (developer, amount, last_updated)
      VALUES (?, ?, ?)
      ON CONFLICT(developer) DO UPDATE SET
      amount = amount + excluded.amount,
      last_updated = excluded.last_updated
    `);

    // Use a transaction for atomicity
    const processSales = db.transaction(() => {
      for (const sale of unprocessedSales) {
        // Calculate royalty
        const royaltyAmount = calculateRoyalty(
          sale.price,
          parseInt(sale.publish_time),
          parseInt(sale.timestamp),
          params
        );

        console.log(`Calculated royalty for sale ${sale.id}: ${ethers.utils.formatEther(royaltyAmount)} ETH`);

        // Update sale record
        updateSaleStmt.run(royaltyAmount, sale.id);

        // Update pending royalties
        updateRoyaltyStmt.run(
          sale.developer,
          royaltyAmount,
          Math.floor(Date.now() / 1000)
        );
      }
    });

    processSales();
    console.log('Royalty calculations completed');
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
      }else if (req.url === '/') {
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
