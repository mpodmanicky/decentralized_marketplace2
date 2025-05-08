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
    expect(await repo1Instance.ownerOf(tokenId1)).to.equal(dev1.address);

    await repo2Instance.connect(dev2).mintSoftware("ipfs://QmSoftware2", [], []);
    const tokenId2 = (await repo2Instance.softwareCount()).toString();
    expect(tokenId2).to.equal("1");
    expect(await repo2Instance.ownerOf(tokenId2)).to.equal(dev2.address);

    // // Mint software with dependency
    // await repo1Instance.connect(dev1).mintSoftware("ipfs://QmSoftware3", [dev2Repository], [[1]]);
    // const tokenId3 = (await repo1Instance.softwareCount()).toString();
    // expect(tokenId3).to.equal("1"); // will fail since, he doesnt have a license
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
    const dev1InitialBalance = await ethers.provider.getBalance(dev1.address);

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

    expect(buyerFinalBalance).to.be.below(buyerInitialBalance); // buyer should have lower balance
    expect(dev2FinalBalance).to.be.equal(dev2InitialBalance); // bacuse fees are stored in royaltymanager

    const tx2 = await marketplace.connect(dev1).buySoftware(dev2Repository, 1, {value: ethers.utils.parseEther("2")});
    const receipt2 = await tx2.wait();

    const dev1LicenseId = receipt2.events.find((e) => e.event === "LicensePurchased").args.licenseId;
    console.log("Minted License for DEV1 with ID: ", dev1LicenseId.toString());

    const licenseOwner2 = await licenseManager.ownerOf(dev1LicenseId);
    expect(licenseOwner2).to.equal(dev1.address);

    const dev1finalBalance = await ethers.provider.getBalance(dev1.address);
    const dev2FinalBalance2 = await ethers.provider.getBalance(dev2.address);

    expect(dev1finalBalance).to.be.below(dev1InitialBalance);
    expect(dev2FinalBalance2).to.be.equal(dev2InitialBalance);
  });

  it("Should allow developer to mint software NFTs with dependencies", async function () {
    const repo1Instance = await Repository.attach(dev1Repository);

    console.log("Dev1 address: ", dev1.address);
    console.log("dev1Repository owner: ", await repo1Instance.getOwner());
    console.log("dev1Repository developer: ", await repo1Instance.getDeveloper());

    // Mint software with dependency
    await repo1Instance.connect(dev1).mintSoftware("ipfs://QmSoftware3", [dev2Repository], [[1]]);
    const tokenId3 = (await repo1Instance.softwareCount()).toString();
    expect(tokenId3).to.equal("2"); // will fail since, he doesnt have a license
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
  it("Should know about corss-contract reference relationships", async function() {
    const dev1Repo = await Repository.attach(dev1Repository);
    const dev2Repo = await Repository.attach(dev2Repository);

    const [address, tokenId] = await dev1Repo.referringOf(dev1Repository, 2);
    console.log([address, tokenId]);
    expect(address).to.include(dev2Repository);
    const [address2, tokenId2] = await dev2Repo.referredOf(dev2Repository, 1);
    console.log([address2, tokenId2]);
    expect(address2).to.include(dev1Repository);
  })
  it("Should properly store and track royalties in RoyaltyManager", async function() {
    // Get the RoyaltyManager from the Registry
    const RoyaltyManager = await ethers.getContractFactory("RoyaltyManager");
    const royaltyManagerAddress = await registry.getRoyaltyManager();
    const royaltyManager = await RoyaltyManager.attach(royaltyManagerAddress);

    console.log("RoyaltyManager address:", royaltyManagerAddress);

    // Check initial pending royalties for dev2 (should have royalties from previous purchases)
    const initialPendingRoyalties = await royaltyManager.getPendingRoyalties(dev2.address);
    console.log("Dev2 initial pending royalties:", ethers.utils.formatEther(initialPendingRoyalties));

    // Verify that dev2 has received royalties from previous purchases (2 ETH from buyer + 2 ETH from dev1)
    expect(initialPendingRoyalties).to.equal(ethers.utils.parseEther("4"));

    // Make another purchase from buyer to generate more royalties
    const initialBuyerBalance = await ethers.provider.getBalance(buyer.address);

    await marketplace.connect(buyer).buySoftware(dev2Repository, 1, {
      value: ethers.utils.parseEther("2"),
    });

    // Check updated pending royalties for dev2
    const updatedPendingRoyalties = await royaltyManager.getPendingRoyalties(dev2.address);
    console.log("Dev2 updated pending royalties:", ethers.utils.formatEther(updatedPendingRoyalties));

    // Should have 2 ETH more than before
    expect(updatedPendingRoyalties).to.equal(
      initialPendingRoyalties.add(ethers.utils.parseEther("2"))
    );

    // Get dev2's initial balance before withdrawal
    const dev2BalanceBeforeWithdrawal = await ethers.provider.getBalance(dev2.address);

    // Dev2 withdraws royalties
    const withdrawTx = await royaltyManager.connect(dev2).withdrawRoyalties();
    const withdrawReceipt = await withdrawTx.wait();

    // Calculate gas cost
    const gasCost = withdrawReceipt.gasUsed.mul(withdrawReceipt.effectiveGasPrice);

    // Get dev2's balance after withdrawal
    const dev2BalanceAfterWithdrawal = await ethers.provider.getBalance(dev2.address);

    // Check that dev2 received the correct amount (minus gas costs)
    const expectedBalance = dev2BalanceBeforeWithdrawal
      .add(updatedPendingRoyalties)
      .sub(gasCost);

    console.log("Dev2 balance before withdrawal:", ethers.utils.formatEther(dev2BalanceBeforeWithdrawal));
    console.log("Dev2 balance after withdrawal:", ethers.utils.formatEther(dev2BalanceAfterWithdrawal));
    console.log("Gas cost for withdrawal:", ethers.utils.formatEther(gasCost));

    expect(dev2BalanceAfterWithdrawal).to.equal(expectedBalance);

    // Verify that pending royalties are now reset to 0
    const royaltiesAfterWithdrawal = await royaltyManager.getPendingRoyalties(dev2.address);
    expect(royaltiesAfterWithdrawal).to.equal(0);

    // Verify that attempting to withdraw again fails
    await expect(
      royaltyManager.connect(dev2).withdrawRoyalties()
    ).to.be.reverted; // Using the general "reverted" check instead

    // Verify the events from the original purchases
    const royaltyAddedEvents = await royaltyManager.queryFilter(
      royaltyManager.filters.RoyaltyAdded(dev2.address)
    );

    console.log("Number of RoyaltyAdded events for dev2:", royaltyAddedEvents.length);
    expect(royaltyAddedEvents.length).to.be.at.least(3); // Three purchases were made

    // Verify the withdrawal event
    const withdrawEvents = await royaltyManager.queryFilter(
      royaltyManager.filters.RoyaltyWithdrawn(dev2.address)
    );

    expect(withdrawEvents.length).to.equal(1);
    expect(withdrawEvents[0].args.amount).to.equal(updatedPendingRoyalties);
  });
  it("Should allow for more complex royalty distribution metadata tracking", async function() {
    // Get the RoyaltyManager from the Registry
    const RoyaltyManager = await ethers.getContractFactory("RoyaltyManager");
    const royaltyManagerAddress = await registry.getRoyaltyManager();
    const royaltyManager = await RoyaltyManager.attach(royaltyManagerAddress);

    // List dev1's software with dependency (token ID 2) on the marketplace
    const listingPrice = ethers.utils.parseEther("3"); // 3 ETH
    await marketplace.connect(dev1).listSoftware(2, listingPrice);

    // Verify the software is listed
    expect(await marketplace.checkIsListed(dev1Repository, 2)).to.equal(true);
    console.log("Dev1's software with dependency is now listed for", ethers.utils.formatEther(listingPrice), "ETH");

    // Buyer purchases dev1's software that depends on dev2's software
    const purchaseTx = await marketplace.connect(buyer).buySoftware(dev1Repository, 2, {
      value: listingPrice
    });
    const purchaseReceipt = await purchaseTx.wait();

    // Extract the licenseId from the event
    const licenseId = purchaseReceipt.events.find(e => e.event === "LicensePurchased").args.licenseId;
    console.log("Buyer received license ID:", licenseId.toString(), "for dev1's software with dependency");

    // Verify license ownership
    expect(await licenseManager.ownerOf(licenseId)).to.equal(buyer.address);

    // Check for SaleMade event which the indexer would use for off-chain calculations
    const saleEvents = await royaltyManager.queryFilter(
      royaltyManager.filters.SaleMade(),
      purchaseReceipt.blockNumber,
      purchaseReceipt.blockNumber
    );

    console.log("Sale events emitted:", saleEvents.length);
    expect(saleEvents.length).to.be.at.least(1);

    // Verify the SaleMade event has all necessary data for the indexer
    const saleEvent = saleEvents.find(e => e.args.repository === dev1Repository && e.args.softwareId.toString() === "2");
    expect(saleEvent).to.not.be.undefined;

    console.log("Sale event details:");
    console.log("- Repository:", saleEvent.args.repository);
    console.log("- Software ID:", saleEvent.args.softwareId.toString());
    console.log("- Price:", ethers.utils.formatEther(saleEvent.args.price));
    console.log("- Timestamp:", saleEvent.args.timestamp.toString());

    // Verify the sale price matches the listing price
    expect(saleEvent.args.price).to.equal(listingPrice);

    // Verify publish time is recorded for software dependency calculation
    const dev1SoftwarePublishTime = await royaltyManager.softwarePublishTime(dev1Repository, 2);
    const dev2SoftwarePublishTime = await royaltyManager.softwarePublishTime(dev2Repository, 1);

    console.log("Dev1 software publish time:", dev1SoftwarePublishTime.toString());
    console.log("Dev2 software publish time:", dev2SoftwarePublishTime.toString());

    // Dev2's software should have been published before Dev1's
    expect(dev2SoftwarePublishTime).to.be.lt(dev1SoftwarePublishTime);

    // Check for SoftwarePublished events - should have been emitted when software was published
    const publishEvents = await royaltyManager.queryFilter(
      royaltyManager.filters.SoftwarePublished()
    );

    const dev1PublishEvent = publishEvents.find(
      e => e.args.repository === dev1Repository && e.args.softwareId.toString() === "2"
    );
    const dev2PublishEvent = publishEvents.find(
      e => e.args.repository === dev2Repository && e.args.softwareId.toString() === "1"
    );

    expect(dev1PublishEvent).to.not.be.undefined;
    expect(dev2PublishEvent).to.not.be.undefined;

    console.log("Dev1 software publish event timestamp:", dev1PublishEvent.args.publishTime.toString());
    console.log("Dev2 software publish event timestamp:", dev2PublishEvent.args.publishTime.toString());

    // Check that RoyaltyParametersUpdated event was emitted (usually in constructor)
    // This provides the indexer with calculation parameters
    const paramEvents = await royaltyManager.queryFilter(
      royaltyManager.filters.RoyaltyParametersUpdated()
    );

    expect(paramEvents.length).to.be.at.least(1);
    const latestParamEvent = paramEvents[paramEvents.length - 1];

    console.log("Royalty parameters from event:");
    console.log("- Initial rate:", latestParamEvent.args.initialRate.toString());
    console.log("- Decay factor:", latestParamEvent.args.decayFactor.toString());
    console.log("- Decay period:", latestParamEvent.args.decayPeriod.toString());

    // Verify the proper dependency data is available for the indexer
    const dev1Repo = await Repository.attach(dev1Repository);
    const [dependencies, depTokenIds] = await dev1Repo.getSoftwareDependencies(2);

    console.log("Dependencies available to indexer:");
    for (let i = 0; i < dependencies.length; i++) {
      console.log(`- Repository: ${dependencies[i]}, Token IDs: ${depTokenIds[i]}`);
      expect(dependencies[i]).to.equal(dev2Repository);
      expect(depTokenIds[i][0]).to.equal(1);
    }
  });
});
