const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Decentralized Marketplace", function () {
  let owner, dev1, dev2, buyer;
  let registry, licenseManager, marketplace, repository;
  let dev1Repository, dev2Repository;
  let Registry, Repository, Marketplace;

  before(async function () {
    [owner, dev1, dev2, buyer] = await ethers.getSigners();

    console.log("Owner address:", owner.address);
    console.log("Dev1 address:", dev1.address);
    console.log("Dev2 address:", dev2.address);
    console.log("Buyer address:", buyer.address);

    Registry = await ethers.getContractFactory("Registry");
    Marketplace = await ethers.getContractFactory("Marketplace");
    Repository = await ethers.getContractFactory("Repository");
    const LicenseManager = await ethers.getContractFactory("LicenseManager");

    // deploy registry
    registry = await Registry.connect(owner).deploy();
    await registry.deployed()
    console.log("Registry deployed to: ", registry.address);

    // Get the licenseManager address
    const licenseManagerAddress = await registry.getLicenseManager();
    // Attach to the deployed licenseManager
    licenseManager = await LicenseManager.attach(licenseManagerAddress);
    console.log("License Manager deployed to: ", licenseManagerAddress);
    console.log("License Manager instance address: ", licenseManager.address);

    // deploy marketplace
    marketplace = await Marketplace.connect(owner).deploy(registry.address);
    await marketplace.deployed();
    console.log("Marketplace deployed to: ", marketplace.address);

    // Set marketplace in registry
    await registry.connect(owner).setMarketplace(marketplace.address);
    console.log("Marketplace set in Registry");
  });

  it("Should allow developers to create repositories", async function () {
    try {
      // Call createRepository and retrieve the repository address
      const dev1Tx = await registry.connect(dev1).createRepository();
      const dev1Receipt = await dev1Tx.wait();
      dev1Repository = await registry.getRepositoryContract(dev1.address);
      console.log("Dev1 repository: ", dev1Repository);

      const dev2Tx = await registry.connect(dev2).createRepository();
      const dev2Receipt = await dev2Tx.wait();
      dev2Repository = await registry.getRepositoryContract(dev2.address);
      console.log("Dev2 repository: ", dev2Repository);

      // Validate that the repositories are correctly registered
      expect(await registry.getRepositoryContract(dev1.address)).to.equal(dev1Repository);
      expect(await registry.getRepositoryContract(dev2.address)).to.equal(dev2Repository);
    } catch (error) {
      console.error("Repository creation error: ", error);
      throw error;
    }
  });

  it("Should allow developers to mint software NFTs", async function () {
    const repo1Instance = await Repository.attach(dev1Repository);
    const repo2Instance = await Repository.attach(dev2Repository);

    console.log("Dev1 address: ", dev1.address);
    console.log("dev1Repository owner: ", await repo1Instance.getOwner());
    console.log("dev1Repository developer: ", await repo1Instance.getDeveloper());

    // Mint software through the Registry
    await repo1Instance.connect(dev1).mintSoftware("ipfs://QmSoftware1", [], []);
    const tokenId1 = (await repo1Instance.softwareCount()).toString();
    expect(tokenId1).to.equal("1");

    await repo2Instance.connect(dev2).mintSoftware("ipfs://QmSoftware2", [], []);
    const tokenId2 = (await repo2Instance.softwareCount()).toString();
    expect(tokenId2).to.equal("1");

    // Mint software with dependency
    await repo1Instance.connect(dev1).mintSoftware("ipfs://QmSoftware3", [dev2Repository], [[1]]);
    const tokenId3 = (await repo1Instance.softwareCount()).toString();
    expect(tokenId3).to.equal("2");
  });

  it("Should allow developers to list software on the marketplace", async function () {
    // List software on the marketplace
    await marketplace.connect(dev1).listSoftware(1, ethers.utils.parseEther("1"));
    expect(await marketplace.checkIsListed(dev1Repository, 1)).to.equal(true);

    await marketplace.connect(dev2).listSoftware(1, ethers.utils.parseEther("2"));
    expect(await marketplace.checkIsListed(dev2Repository, 1)).to.equal(true);
  });

  it("Should allow buyers to purchase software licenses", async function () {
    const buyerInitialBalance = await ethers.provider.getBalance(buyer.address);
    const dev2InitialBalance = await ethers.provider.getBalance(dev2.address);

    // Buy software and mint license
    const tx = await marketplace.connect(buyer).buySoftware(dev2Repository, 1, {
      value: ethers.utils.parseEther("2"),
    });
    const receipt = await tx.wait();

    // Extract the licenseId from the return value
    const licenseId = receipt.events.find((e) => e.event === "LicensePurchased").args.licenseId;

    console.log("Minted License ID:", licenseId.toString());

    // Get the owner of the newly minted license
    const licenseOwner = await licenseManager.ownerOf(licenseId);
    expect(licenseOwner).to.equal(buyer.address);

    const buyerFinalBalance = await ethers.provider.getBalance(buyer.address);
    const dev2FinalBalance = await ethers.provider.getBalance(dev2.address);

    expect(buyerFinalBalance).to.be.below(buyerInitialBalance);
    expect(dev2FinalBalance).to.be.above(dev2InitialBalance);
  });

  it("Should display the dependency tree for software", async function () {
    const dev1Repo = await Repository.attach(dev1Repository);

    // Query dependencies for the second software
    const [deps, depTokenIds] = await dev1Repo.getSoftwareDependencies(2);
    console.log([deps, depTokenIds]);
    expect(deps.length).to.equal(1);
    expect(deps[0]).to.equal(dev2Repository);
    expect(depTokenIds[0][0]).to.equal(1);
  });
});
