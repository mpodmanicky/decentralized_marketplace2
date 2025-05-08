const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  // Load addresses
  let addresses;
  try {
    addresses = JSON.parse(fs.readFileSync(path.join(__dirname, '../addresses.json'), 'utf8'));
  } catch (error) {
    console.error('Error loading addresses.json:', error.message);
    process.exit(1);
  }

  // Get contract instances
  const Marketplace = await ethers.getContractFactory('Marketplace');
  const marketplace = await Marketplace.attach(addresses.marketplace);

  // Get signers
  const [owner, dev1, dev2, buyer] = await ethers.getSigners();

  console.log('Simulating purchases...');

  // Buyer purchases software from dev2
  console.log('Buyer purchasing software from dev2...');
  const tx1 = await marketplace.connect(buyer).buySoftware(
    addresses.dev2Repository,
    1,
    { value: ethers.utils.parseEther('2') }
  );
  const receipt1 = await tx1.wait();
  console.log('Purchase complete! Transaction hash:', tx1.hash);

  // Extract the event
  const event = receipt1.events.find(e => e.event === 'LicensePurchased');
  if (event) {
    const licenseId = event.args.licenseId;
    console.log('License ID:', licenseId.toString());
  } else {
    console.log('LicensePurchased event not found in transaction receipt');
  }

  // Wait a bit to allow the indexer to process the event
  console.log('Waiting for indexer to process events...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  console.log('Simulation complete!');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
