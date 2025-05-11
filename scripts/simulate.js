const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

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

  // Get ERC-5521 interface for verification
  const ERC5521 = await ethers.getContractFactory('ERC_5521');

  // Get signers - we'll use more accounts for a complex simulation
  const [owner, dev1, dev2, dev3, buyer1, buyer2, buyer3] = await ethers.getSigners();

  console.log('=== Starting Marketplace Simulation - License Dependencies with ERC-5521 ===');
  console.log('Owner:', owner.address);
  console.log('Dev1:', dev1.address);
  console.log('Dev2:', dev2.address);
  console.log('Dev3:', dev3.address);
  console.log('Buyer1:', buyer1.address);
  console.log('Buyer2:', buyer2.address);
  console.log('Buyer3:', buyer3.address);

  // Function to verify ERC-5521 compatibility
  async function verifyERC5521Support(repo) {
    try {
      const repoERC5521 = await ERC5521.attach(repo);
      // Check if contract supports ERC-5521 interface
      const supportsInterface = await repoERC5521.supportsInterface('0x4179b1ee');
      console.log(`Repository ${repo} ERC-5521 support: ${supportsInterface ? 'YES ✓' : 'NO ✗'}`);
      return supportsInterface;
    } catch (error) {
      console.error(`Error verifying ERC-5521 support:`, error.message);
      return false;
    }
  }

  // Function to verify relationship in ERC-5521 DAG
  async function verifyReferringRelationship(fromRepo, fromId, toRepo, toId) {
    try {
      const repoERC5521 = await ERC5521.attach(fromRepo);
      const [referringRepos, referringTokenIds] = await repoERC5521.referringOf(fromRepo, fromId);

      // Check if relationship exists
      for (let i = 0; i < referringRepos.length; i++) {
        if (referringRepos[i].toLowerCase() === toRepo.toLowerCase()) {
          for (let j = 0; j < referringTokenIds[i].length; j++) {
            if (referringTokenIds[i][j].toString() === toId.toString()) {
              return true;
            }
          }
        }
      }
      return false;
    } catch (error) {
      console.error(`Error verifying ERC-5521 relationship:`, error.message);
      return false;
    }
  }

  // Helper function to trigger indexer analysis
  async function triggerIndexerAnalysis(repo, softwareId) {
    try {
      console.log(`Triggering indexer analysis for ${repo}-${softwareId}...`);
      const indexerUrl = 'http://localhost:3000';
      await axios.get(`${indexerUrl}/api/analyze/${repo}/${softwareId}`);
      console.log(`Indexer analysis triggered successfully.`);
    } catch (error) {
      console.log(`Couldn't reach indexer, continuing with simulation: ${error.message}`);
    }
  }

  // Create repositories for all developers if needed
  let dev3Repository;
  try {
    console.log('\n=== Setting up repositories ===');
    if (!addresses.dev3Repository) {
      console.log('Creating repository for dev3...');
      const tx = await registry.connect(dev3).createRepository();
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

    // Verify ERC-5521 support for all repositories
    console.log('\n=== Verifying ERC-5521 Support ===');
    await verifyERC5521Support(addresses.dev1Repository);
    await verifyERC5521Support(addresses.dev2Repository);
    await verifyERC5521Support(dev3Repository);
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

      // Trigger indexer analysis
      await triggerIndexerAnalysis(dev3Repository, 1);
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
    const hasLicense = await licenseManager.hasLicense(dev2.address, dev3Repository, 1);
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

      // Trigger indexer analysis
      await triggerIndexerAnalysis(addresses.dev2Repository, 2);
    } else {
      console.log('Dev2 already has framework software with ID:', softwareCount2.toString());
    }

    // Verify the dependency relationship was recorded correctly - traditional method
    const [deps, depTokenIds] = await repo2Instance.getSoftwareDependencies(2);
    if (deps.length > 0) {
      console.log('Traditional dependency verification:');
      console.log('- Depends on repository:', deps[0]);
      console.log('- Depends on token ID:', depTokenIds[0][0].toString());
      console.log('- Verification:',
        deps[0] === dev3Repository && depTokenIds[0][0].toString() === '1'
          ? 'PASSED ✓'
          : 'FAILED ✗'
      );
    }

    // Verify using ERC-5521 relationship
    console.log('ERC-5521 dependency verification:');
    const hasRelationship = await verifyReferringRelationship(
      addresses.dev2Repository,
      2,
      dev3Repository,
      1
    );
    console.log(`- ERC-5521 referringOf verification: ${hasRelationship ? 'PASSED ✓' : 'FAILED ✗'}`);

    // Now check the reverse relationship using referredOf
    try {
      const repo3ERC5521 = await ERC5521.attach(dev3Repository);
      const [referredRepos, referredTokenIds] = await repo3ERC5521.referredOf(dev3Repository, 1);

      let foundReverseRelationship = false;
      for (let i = 0; i < referredRepos.length; i++) {
        if (referredRepos[i].toLowerCase() === addresses.dev2Repository.toLowerCase()) {
          for (let j = 0; j < referredTokenIds[i].length; j++) {
            if (referredTokenIds[i][j].toString() === '2') {
              foundReverseRelationship = true;
              break;
            }
          }
        }
      }

      console.log(`- ERC-5521 referredOf verification: ${foundReverseRelationship ? 'PASSED ✓' : 'FAILED ✗'}`);
    } catch (error) {
      console.error('Error verifying referredOf relationship:', error.message);
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
    const hasLibraryLicense = await licenseManager.hasLicense(dev1.address, dev3Repository, 1);
    const hasFrameworkLicense = await licenseManager.hasLicense(dev1.address, addresses.dev2Repository, 2);

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

      // Trigger indexer analysis
      await triggerIndexerAnalysis(addresses.dev1Repository, 3);

      // Verify ERC-5521 relationships
      console.log('\n=== Verifying Complex Dependency Relationships using ERC-5521 ===');

      // Check Dev1's app refers to Dev2's framework
      const refersToFramework = await verifyReferringRelationship(
        addresses.dev1Repository,
        3,
        addresses.dev2Repository,
        2
      );
      console.log(`Dev1's app refers to Dev2's framework: ${refersToFramework ? 'YES ✓' : 'NO ✗'}`);

      // Check Dev1's app refers to Dev3's library
      const refersToLibrary = await verifyReferringRelationship(
        addresses.dev1Repository,
        3,
        dev3Repository,
        1
      );
      console.log(`Dev1's app refers to Dev3's library: ${refersToLibrary ? 'YES ✓' : 'NO ✗'}`);

      // Check that Dev3's library is referred to by both Dev1's app and Dev2's framework
      try {
        const repo3ERC5521 = await ERC5521.attach(dev3Repository);
        const [referredRepos, referredTokenIds] = await repo3ERC5521.referredOf(dev3Repository, 1);

        // Count how many software pieces refer to Dev3's library
        let referCount = 0;
        let referredByDev1 = false;
        let referredByDev2 = false;

        for (let i = 0; i < referredRepos.length; i++) {
          if (referredRepos[i].toLowerCase() === addresses.dev1Repository.toLowerCase()) {
            for (let j = 0; j < referredTokenIds[i].length; j++) {
              if (referredTokenIds[i][j].toString() === '3') {
                referredByDev1 = true;
                referCount++;
                break;
              }
            }
          }

          if (referredRepos[i].toLowerCase() === addresses.dev2Repository.toLowerCase()) {
            for (let j = 0; j < referredTokenIds[i].length; j++) {
              if (referredTokenIds[i][j].toString() === '2') {
                referredByDev2 = true;
                referCount++;
                break;
              }
            }
          }
        }

        console.log(`Dev3's library is referred to by ${referCount} software pieces`);
        console.log(`- Referred by Dev1's app: ${referredByDev1 ? 'YES ✓' : 'NO ✗'}`);
        console.log(`- Referred by Dev2's framework: ${referredByDev2 ? 'YES ✓' : 'NO ✗'}`);
      } catch (error) {
        console.error('Error checking referredOf for Dev3 library:', error.message);
      }
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

    // Allow time for indexer to process the sale
    console.log('Waiting for indexer to process royalty distribution...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check royalty distribution
    console.log('\nRoyalty distribution after purchase:');
    const dev1Royalties = await royaltyManager.getPendingRoyalties(dev1.address);
    const dev2Royalties = await royaltyManager.getPendingRoyalties(dev2.address);
    const dev3Royalties = await royaltyManager.getPendingRoyalties(dev3.address);

    console.log('- Dev1 (primary author):', ethers.utils.formatEther(dev1Royalties), 'ETH');
    console.log('- Dev2 (framework author):', ethers.utils.formatEther(dev2Royalties), 'ETH');
    console.log('- Dev3 (library author):', ethers.utils.formatEther(dev3Royalties), 'ETH');

    // Check the depth-based royalty calculation
    console.log('\nEvaluating depth-based royalty distribution:');
    console.log('- Dev1 (depth 0): Primary author');
    console.log('- Dev2 (depth 1): Direct dependency of Dev1');
    console.log('- Dev3 (depth 1 & 2): Direct dependency of Dev1 and indirect dependency through Dev2');

    // Check if royalties align with depth-based decay algorithm
    if (dev1Royalties.gt(dev2Royalties) && dev2Royalties.gt(0)) {
      console.log('✓ Primary author (Dev1) received more than dependency author (Dev2)');
    } else {
      console.log('❌ Royalty distribution doesn\'t follow expected pattern');
    }

    if (dev3Royalties.gt(0)) {
      console.log('✓ Deep dependency author (Dev3) received royalties');
    } else {
      console.log('❌ Deep dependency author (Dev3) didn\'t receive royalties');
    }

    // Try to get detailed royalty information from indexer
    try {
      const indexerUrl = 'http://localhost:3000';
      const response = await axios.get(`${indexerUrl}/api/royalties/dependency/${dev3.address}`);
      if (response.data && response.data.royalties) {
        console.log('\nDetailed royalty breakdown from indexer for Dev3:');
        for (const royalty of response.data.royalties) {
          console.log(`- Sale: ${royalty.sale_id.substring(0, 10)}...`);
          console.log(`  Amount: ${ethers.utils.formatEther(royalty.amount)} ETH`);
          console.log(`  Depth: ${royalty.depth}`);
          console.log(`  Rate: ${royalty.rate}%`);
        }
      }
    } catch (error) {
      console.log('Couldn\'t fetch detailed royalty data from indexer:', error.message);
    }

    // Conclusion with ERC-5521 integration
    console.log('\n=== Summary with ERC-5521 Integration ===');
    console.log('1. Dev3 created a base library (no dependencies)');
    console.log('2. Dev2 PURCHASED A LICENSE for Dev3\'s library before using it as a dependency');
    console.log('3. Dev2 created a framework using Dev3\'s library as a dependency');
    console.log('   - This created an ERC-5521 "referring" relationship from Dev2\'s framework to Dev3\'s library');
    console.log('   - It also created a "referred" relationship from Dev3\'s library to Dev2\'s framework');
    console.log('4. Dev1 PURCHASED LICENSES for both Dev2\'s framework and Dev3\'s library');
    console.log('5. Dev1 created a complex application using both as dependencies');
    console.log('   - This created ERC-5521 relationships from Dev1\'s app to both dependencies');
    console.log('   - The ERC-5521 DAG now has multiple paths to Dev3\'s library (direct and via Dev2\'s framework)');
    console.log('6. Buyer1 purchased Dev1\'s complex application');
    console.log('7. Royalties were distributed using a depth-based decay algorithm:');
    console.log('   - Dev1 received primary author royalties (depth 0)');
    console.log('   - Dev2 received dependency royalties (depth 1)');
    console.log('   - Dev3 received royalties for both direct (depth 1) and indirect (depth 2) dependencies');
    console.log('8. The indexer analyzed the ERC-5521 DAG to determine the correct depth of each dependency');
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
