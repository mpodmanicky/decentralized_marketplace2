const { ethers } = require('hardhat');
const fs = require('fs');

async function main() {
  const [owner, dev1, dev2, buyer] = await ethers.getSigners();

  console.log('Deploying contracts with account:', owner.address);

  // Deploy Registry
  const Registry = await ethers.getContractFactory('Registry');
  const registry = await Registry.deploy();
  await registry.deployed();
  console.log('Registry deployed to:', registry.address);

  // Get RoyaltyManager address
  const royaltyManagerAddress = await registry.getRoyaltyManager();
  console.log('RoyaltyManager deployed to:', royaltyManagerAddress);

  // Get LicenseManager address
  const licenseManagerAddress = await registry.getLicenseManager();
  console.log('LicenseManager deployed to:', licenseManagerAddress);

  // Deploy Marketplace
  const Marketplace = await ethers.getContractFactory('Marketplace');
  const marketplace = await Marketplace.deploy(registry.address);
  await marketplace.deployed();
  console.log('Marketplace deployed to:', marketplace.address);

  // Set Marketplace in Registry
  await registry.setMarketplace(marketplace.address);
  console.log('Marketplace set in Registry');

  // Create developer repositories
  console.log('Creating repositories for developers...');
  await registry.connect(dev1).createRepository();
  await registry.connect(dev2).createRepository();

  const dev1Repository = await registry.getRepositoryContract(dev1.address);
  const dev2Repository = await registry.getRepositoryContract(dev2.address);

  console.log('Dev1 repository:', dev1Repository);
  console.log('Dev2 repository:', dev2Repository);

  // Get repository instances
  const Repository = await ethers.getContractFactory('Repository');
  const repo1 = await Repository.attach(dev1Repository);
  const repo2 = await Repository.attach(dev2Repository);

  // Mint software
  console.log('Minting software...');
  let tx1 = await repo1.connect(dev1).mintSoftware('ipfs://QmSoftware1', [], []);
  await tx1.wait();
  console.log('Software 1 minted');

  let tx2 = await repo2.connect(dev2).mintSoftware('ipfs://QmSoftware2', [], []);
  await tx2.wait();
  console.log('Software 2 minted');

  // List software on marketplace
  console.log('Listing software on marketplace...');
  tx1 = await marketplace.connect(dev1).listSoftware(1, ethers.utils.parseEther('1'));
  await tx1.wait();
  console.log('Software 1 listed for 1 ETH');

  tx2 = await marketplace.connect(dev2).listSoftware(1, ethers.utils.parseEther('2'));
  await tx2.wait();
  console.log('Software 2 listed for 2 ETH');

  // Save addresses for the indexer
  const addresses = {
    owner: owner.address,
    dev1: dev1.address,
    dev2: dev2.address,
    buyer: buyer.address,
    registry: registry.address,
    licenseManager: licenseManagerAddress,
    royaltyManager: royaltyManagerAddress,
    marketplace: marketplace.address,
    dev1Repository,
    dev2Repository
  };

  fs.writeFileSync(
    './addresses.json',
    JSON.stringify(addresses, null, 2)
  );

  console.log('Deployment complete! Addresses saved to addresses.json');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
