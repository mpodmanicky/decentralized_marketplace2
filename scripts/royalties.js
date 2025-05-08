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
  const RoyaltyManager = await ethers.getContractFactory('RoyaltyManager');
  const royaltyManager = await RoyaltyManager.attach(addresses.royaltyManager);

  // Get signers
  const [owner, dev1, dev2, buyer] = await ethers.getSigners();

  // Check pending royalties
  const dev1Royalties = await royaltyManager.pendingRoyalties(dev1.address);
  const dev2Royalties = await royaltyManager.pendingRoyalties(dev2.address);

  console.log('Dev1 pending royalties:', ethers.utils.formatEther(dev1Royalties), 'ETH');
  console.log('Dev2 pending royalties:', ethers.utils.formatEther(dev2Royalties), 'ETH');

  // Withdraw royalties if available
  if (dev2Royalties.gt(0)) {
    console.log('Dev2 withdrawing royalties...');
    const tx = await royaltyManager.connect(dev2).withdrawRoyalties();
    await tx.wait();
    console.log('Withdrawal complete! Transaction hash:', tx.hash);

    // Check new balance
    const newDev2Royalties = await royaltyManager.pendingRoyalties(dev2.address);
    console.log('Dev2 new pending royalties:', ethers.utils.formatEther(newDev2Royalties), 'ETH');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
