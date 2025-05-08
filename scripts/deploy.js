const { ethers } = require("hardhat");

async function main() {
  console.log("Deploying contracts...");

  // Deploy Registry
  const Registry = await ethers.getContractFactory("Registry");
  const registry = await Registry.deploy();
  await registry.deployed();
  console.log("Registry deployed to:", registry.address);

  // Deploy Marketplace with Registry address
  const Marketplace = await ethers.getContractFactory("Marketplace");
  const marketplace = await Marketplace.deploy(registry.address);
  await marketplace.deployed();
  console.log("Marketplace deployed to:", marketplace.address);

  // Set marketplace address in Registry
  await registry.setMarketplace(marketplace.address);
  console.log("Marketplace set in Registry");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
