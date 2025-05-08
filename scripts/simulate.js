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
  const Registry = await ethers.getContractFactory('Registry');
  const registry = await Registry.attach(addresses.registry);

  const Marketplace = await ethers.getContractFactory('Marketplace');
  const marketplace = await Marketplace.attach(addresses.marketplace);

  const Repository = await ethers.getContractFactory('Repository');

  const LicenseManager = await ethers.getContractFactory('LicenseManager');
  const licenseManagerAddress = await registry.getLicenseManager();
  const licenseManager = await LicenseManager.attach(licenseManagerAddress);

  const RoyaltyManager = await ethers.getContractFactory('RoyaltyManager');
  const royaltyManagerAddress = await registry.getRoyaltyManager();
  const royaltyManager = await RoyaltyManager.attach(royaltyManagerAddress);

  // Get signers - we'll use more accounts for a complex simulation
  const [owner, dev1, dev2, dev3, buyer1, buyer2, buyer3] = await ethers.getSigners();

  console.log('=== Starting Marketplace Simulation - License Dependencies ===');
  console.log('Owner:', owner.address);
  console.log('Dev1:', dev1.address);
  console.log('Dev2:', dev2.address);
  console.log('Dev3:', dev3.address);
  console.log('Buyer1:', buyer1.address);
  console.log('Buyer2:', buyer2.address);
  console.log('Buyer3:', buyer3.address);

  // Create repositories for all developers if needed
  let dev3Repository;
  try {
    console.log('\n=== Setting up repositories ===');
    if (!addresses.dev3Repository) {
      console.log('Creating repository for dev3...');
      const tx = await registry.connect(dev3).createRepository("Dev3's Software Repository");
      const receipt = await tx.wait();
      const repoCreatedEvent = receipt.events.find(e => e.event === 'RepositoryCreated');
      dev3Repository = repoCreatedEvent.args.repository;
      console.log('Dev3 Repository created:', dev3Repository);

      // Update addresses file with new repository
      addresses.dev3Repository = dev3Repository;
      fs.writeFileSync(
        path.join(__dirname, '../addresses.json'),
        JSON.stringify(addresses, null, 2)
      );
    } else {
      dev3Repository = addresses.dev3Repository;
      console.log('Using existing dev3 repository:', dev3Repository);
    }
  } catch (error) {
    console.error('Error setting up repositories:', error.message);
  }

  // Attach to repositories
  const repo1Instance = await Repository.attach(addresses.dev1Repository);
  const repo2Instance = await Repository.attach(addresses.dev2Repository);
  const repo3Instance = await Repository.attach(dev3Repository);

  // === PHASE 1: Initial Software Creation ===
  console.log('\n=== PHASE 1: Initial Software Creation ===');

  // Dev3 mints a base library software
  console.log('Dev3 minting base library software...');
  try {
    // Check if software already exists
    const softwareCount3 = await repo3Instance.softwareCount();
    if (softwareCount3.toNumber() === 0) {
      await repo3Instance.connect(dev3).mintSoftware(
        "ipfs://QmBaseLibrary",
        [], // No dependencies
        []
      );
      console.log('Dev3 minted base library (Token ID: 1)');

      // List it on the marketplace
      await marketplace.connect(dev3).listSoftware(1, ethers.utils.parseEther('1'));
      console.log('Dev3 listed base library for 1 ETH');
    } else {
      console.log('Dev3 already has software with ID:', softwareCount3.toString());
    }
  } catch (error) {
    console.error('Error minting dev3 software:', error.message);
  }

  // === PHASE 2: Developer Purchasing License for Dependencies ===
  console.log('\n=== PHASE 2: Developer Purchasing License for Dependencies ===');

  try {
    // First, dev2 needs to buy a license for dev3's library before using it as a dependency
    console.log('Dev2 purchasing license for Dev3\'s base library...');
    console.log('IMPORTANT: Developers must purchase licenses before using software as a dependency');

    const tx = await marketplace.connect(dev2).buySoftware(
      dev3Repository,
      1,
      { value: ethers.utils.parseEther('1') }
    );
    const receipt = await tx.wait();

    // Extract the license ID
    const event = receipt.events.find(e => e.event === 'LicensePurchased');
    if (event) {
      const licenseId = event.args.licenseId;
      console.log('Dev2 received license ID:', licenseId.toString(), 'for Dev3\'s library');

      // Verify license ownership
      const licenseOwner = await licenseManager.ownerOf(licenseId);
      console.log('License owner verification:', licenseOwner === dev2.address ? 'PASSED ✓' : 'FAILED ✗');
    }

    // Check that dev2 now has the required license to use the dependency
    const hasLicense = await licenseManager.hasValidLicense(dev2.address, dev3Repository, 1);
    console.log('Dev2 has valid license for Dev3\'s library:', hasLicense ? 'YES ✓' : 'NO ✗');

    if (!hasLicense) {
      console.error('ERROR: Dev2 does not have required license. Cannot proceed with dependency creation!');
      return;
    }
  } catch (error) {
    console.error('Error purchasing dependency license:', error.message);
    return;
  }

  // === PHASE 3: Creating Software with Dependencies (after acquiring license) ===
  console.log('\n=== PHASE 3: Creating Software with Dependencies ===');

  try {
    console.log('Dev2 creating framework that depends on Dev3\'s library...');
    console.log('Since Dev2 has purchased the required license, they can use it as a dependency');

    // Now dev2 can mint software that depends on dev3's library
    const softwareCount2 = await repo2Instance.softwareCount();
    if (softwareCount2.toNumber() < 2) {
      await repo2Instance.connect(dev2).mintSoftware(
        "ipfs://QmFramework",
        [dev3Repository], // Dependency on dev3's library
        [[1]]
      );
      console.log('Dev2 successfully minted framework with Dev3\'s library as a dependency (Token ID: 2)');

      // List the framework on the marketplace
      await marketplace.connect(dev2).listSoftware(2, ethers.utils.parseEther('2'));
      console.log('Dev2 listed framework for 2 ETH');
    } else {
      console.log('Dev2 already has framework software with ID:', softwareCount2.toString());
    }

    // Verify the dependency relationship was recorded correctly
    const [deps, depTokenIds] = await repo2Instance.getSoftwareDependencies(2);
    if (deps.length > 0) {
      console.log('Dependency verification:');
      console.log('- Depends on repository:', deps[0]);
      console.log('- Depends on token ID:', depTokenIds[0][0].toString());
      console.log('- Verification:',
        deps[0] === dev3Repository && depTokenIds[0][0].toString() === '1'
          ? 'PASSED ✓'
          : 'FAILED ✗'
      );
    }
  } catch (error) {
    console.error('Error creating software with dependencies:', error.message);
  }

  // === PHASE 4: Attempt to Create Software WITHOUT Required License ===
  console.log('\n=== PHASE 4: Demonstrating License Requirement Enforcement ===');

  try {
    console.log('Dev1 attempting to create software with Dev3\'s library as dependency WITHOUT a license...');
    console.log('This should fail because Dev1 has not purchased a license for Dev3\'s library');

    await repo1Instance.connect(dev1).mintSoftware(
      "ipfs://QmFailedApp",
      [dev3Repository], // Trying to use Dev3's library without a license
      [[1]]
    );

    console.error('ERROR: Transaction should have failed but succeeded!');
  } catch (error) {
    console.log('Transaction correctly failed with error:', error.message.substring(0, 150) + '...');
    console.log('✓ License requirement successfully enforced');
  }

  // === PHASE 5: Purchase Required License and Then Create Software ===
  console.log('\n=== PHASE 5: Purchasing Required License & Creating Software ===');

  try {
    // Dev1 purchases licenses for both dev2's framework and dev3's library
    console.log('Dev1 purchasing license for Dev3\'s library...');
    await marketplace.connect(dev1).buySoftware(
      dev3Repository,
      1,
      { value: ethers.utils.parseEther('1') }
    );
    console.log('Dev1 purchased license for Dev3\'s library');

    console.log('\nDev1 purchasing license for Dev2\'s framework...');
    await marketplace.connect(dev1).buySoftware(
      addresses.dev2Repository,
      2, // The framework
      { value: ethers.utils.parseEther('2') }
    );
    console.log('Dev1 purchased license for Dev2\'s framework');

    // Verify license ownership
    const hasLibraryLicense = await licenseManager.hasValidLicense(dev1.address, dev3Repository, 1);
    const hasFrameworkLicense = await licenseManager.hasValidLicense(dev1.address, addresses.dev2Repository, 2);

    console.log('License verification:');
    console.log('- Dev1 has license for Dev3\'s library:', hasLibraryLicense ? 'YES ✓' : 'NO ✗');
    console.log('- Dev1 has license for Dev2\'s framework:', hasFrameworkLicense ? 'YES ✓' : 'NO ✗');

    if (hasLibraryLicense && hasFrameworkLicense) {
      console.log('\nNow Dev1 can create software with those dependencies...');
      await repo1Instance.connect(dev1).mintSoftware(
        "ipfs://QmComplexApp",
        [addresses.dev2Repository, dev3Repository], // Dependencies on both dev2 and dev3
        [[2], [1]]
      );
      console.log('Dev1 successfully minted complex application with multiple dependencies (Token ID: 3)');

      // List the complex app on the marketplace
      await marketplace.connect(dev1).listSoftware(3, ethers.utils.parseEther('5'));
      console.log('Dev1 listed complex application for 5 ETH');
    } else {
      console.error('Missing required licenses. Cannot create software with dependencies.');
    }
  } catch (error) {
    console.error('Error in Phase 5:', error.message);
  }

  // === PHASE 6: Buyer Purchasing Complex Software ===
  console.log('\n=== PHASE 6: Buyer Purchasing Complex Software ===');

  try {
    console.log('Buyer1 purchasing Dev1\'s complex application...');
    const tx = await marketplace.connect(buyer1).buySoftware(
      addresses.dev1Repository,
      3,
      { value: ethers.utils.parseEther('5') }
    );
    const receipt = await tx.wait();

    const event = receipt.events.find(e => e.event === 'LicensePurchased');
    if (event) {
      const licenseId = event.args.licenseId;
      console.log('Buyer1 received license ID:', licenseId.toString(), 'for complex application');
    }

    // Check royalty distribution
    console.log('\nRoyalty distribution after purchase:');
    const dev1Royalties = await royaltyManager.getPendingRoyalties(dev1.address);
    const dev2Royalties = await royaltyManager.getPendingRoyalties(dev2.address);
    const dev3Royalties = await royaltyManager.getPendingRoyalties(dev3.address);

    console.log('- Dev1 (primary author):', ethers.utils.formatEther(dev1Royalties), 'ETH');
    console.log('- Dev2 (framework author):', ethers.utils.formatEther(dev2Royalties), 'ETH');
    console.log('- Dev3 (library author):', ethers.utils.formatEther(dev3Royalties), 'ETH');

    // Conclusion
    console.log('\n=== Summary ===');
    console.log('1. Dev3 created a base library');
    console.log('2. Dev2 PURCHASED A LICENSE for Dev3\'s library before using it as a dependency');
    console.log('3. Dev2 created a framework using Dev3\'s library as a dependency');
    console.log('4. Dev1 PURCHASED LICENSES for both Dev2\'s framework and Dev3\'s library');
    console.log('5. Dev1 created a complex application using both as dependencies');
    console.log('6. Buyer1 purchased Dev1\'s complex application');
    console.log('7. Royalties were distributed to all developers in the dependency chain');
  } catch (error) {
    console.error('Error in final phase:', error.message);
  }

  console.log('\n=== Simulation Complete ===');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
