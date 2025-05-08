// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.4;

import "./ERC_5521.sol";
import "./Repository.sol";

/// @title LicenseManager
/// @dev This contract manages licenses for software in the Repository contracts
contract LicenseManager is ERC_5521 {
    address private immutable owner;
    uint256 private licenseCounter = 1000000;

    mapping(uint256 => address) public licenseToRepository; // licenseId => repository address
    mapping(uint256 => uint256) public licenseToSoftware; // licenseId => softwareId
    mapping(address => mapping(uint256 => uint256[])) public softwareToLicenses; // repository => softwareId => licenseIds

    // Custom errors
    error NotAuthorized();
    error RepositoryNotFound();
    error SoftwareNotFound();

    event LicenseCreated(
        uint256 indexed licenseId,
        address indexed repository,
        uint256 indexed softwareId,
        address licensee
    );

    constructor(address _registry) ERC_5521("Software License", "LICENSE") {
        owner = _registry;
    }

    /// @notice Mint a new license token for a specific software
    /// @param licensee The address that will own the license
    /// @param repository The address of the Repository contract containing the software
    /// @param softwareId The ID of the software being licensed
    /// @return licenseId The ID of the newly minted license
    function mintLicense(
        address licensee,
        address repository,
        uint256 softwareId
    ) public returns (uint256) {
        // Validation
        if (msg.sender != owner) revert NotAuthorized();

        // Check if repository contract exists by calling a function on it
        Repository repo = Repository(repository);
        try repo.getDeveloper() {
            // Repository exists, continue
        } catch {
            revert RepositoryNotFound();
        }

        // Check if software exists in repository
        try repo.getSoftwareURI(softwareId) returns (string memory) {
            // Software exists, continue
        } catch {
            revert SoftwareNotFound();
        }

        // Generate unique license ID
        uint256 licenseId = licenseCounter;
        licenseCounter++;

        // Set up references to the software NFT
        address[] memory refAddresses = new address[](1);
        refAddresses[0] = repository;

        uint256[][] memory refTokenIds = new uint256[][](1);
        uint256[] memory softwareIds = new uint256[](1);
        softwareIds[0] = softwareId;
        refTokenIds[0] = softwareIds;

        // Mint the license NFT with reference to the software NFT
        safeMint(licensee, licenseId, refAddresses, refTokenIds);

        // Get software URI from repository
        string memory softwareURI = repo.getSoftwareURI(softwareId);

        // Set license URI based on software URI
        string memory licenseURI = string(abi.encodePacked("license-for-", softwareURI));
        _setTokenURI(licenseId, licenseURI);

        // Store license mappings
        licenseToRepository[licenseId] = repository;
        licenseToSoftware[licenseId] = softwareId;
        softwareToLicenses[repository][softwareId].push(licenseId);

        emit LicenseCreated(licenseId, repository, softwareId, licensee);

        return licenseId;
    }

    /// @notice Check if an address owns a license for a specific software
    /// @param user The address to check
    /// @param repository The repository contract address
    /// @param softwareId The software ID
    /// @return True if the user has a license for the software
    function hasLicense(address user, address repository, uint256 softwareId) public view returns (bool) {
        uint256[] memory licenses = softwareToLicenses[repository][softwareId];

        for (uint256 i = 0; i < licenses.length; i++) {
            uint256 licenseId = licenses[i];
            if (_exists(licenseId) && ownerOf(licenseId) == user) {
                return true;
            }
        }

        return false;
    }

    /// @notice Get all licenses owned by a user for a specific software
    /// @param user The address to check
    /// @param repository The repository contract address
    /// @param softwareId The software ID
    /// @return Array of license IDs owned by the user for this software
    function getUserLicenses(
        address user,
        address repository,
        uint256 softwareId
    ) public view returns (uint256[] memory) {
        uint256[] memory allLicenses = softwareToLicenses[repository][softwareId];
        uint256 count = 0;

        // First count how many licenses the user owns
        for (uint256 i = 0; i < allLicenses.length; i++) {
            if (_exists(allLicenses[i]) && ownerOf(allLicenses[i]) == user) {
                count++;
            }
        }

        // Create array of the right size
        uint256[] memory userLicenses = new uint256[](count);
        uint256 index = 0;

        // Fill the array
        for (uint256 i = 0; i < allLicenses.length; i++) {
            if (_exists(allLicenses[i]) && ownerOf(allLicenses[i]) == user) {
                userLicenses[index] = allLicenses[i];
                index++;
            }
        }

        return userLicenses;
    }
}
