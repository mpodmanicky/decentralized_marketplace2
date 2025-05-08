// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.4;

/// @title Developer
/// @dev This contract allows the minting of software tokens.
/// It inherits from the ERC_5521 contract.
import "./ERC_5521.sol";

interface ILicenseManager {
    function hasLicense(
        address user,
        address repository,
        uint256 softwareId
    ) external view returns (bool);
}

interface IRegistry {
    function getLicenseManager() external view returns (address);
}

contract Repository is ERC_5521 {
    address private immutable owner;
    address private immutable developer;
    uint256 public softwareCount;

    struct SoftwareMeta {
        address creator;
        string tokenURI;
        address[] deps;
        uint256[][] depTokenIds;
    }

    mapping(uint256 => SoftwareMeta) public softwareMeta; // tokenId => SoftwareMeta

    // custom errors to use revert instead of require to save gas on string
    error notAuthorized();
    error softwareDoesNotExist();
    error missingLicenses(address repository, uint256 tokenId);
    error invalidDependencyArrays();
    error isNotOwner();

    event ReferenceCreated(
        uint256 indexed tokenId,
        address[] addresses,
        uint256[][] tokenIds
    );

    /// TODO registry is the owner [x]
    constructor(
        address _registry,
        address _developer
    ) ERC_5521("Software", "SOF") {
        owner = _registry;
        developer = _developer;
        softwareCount = 0;
    }

    /// @notice The token ID is automatically assigned based on the current counter.
    /// @param _tokenURI The URI for the token metadata.
    /// @param addresses The addresses of the software dependencies.
    /// @param _tokenIds The token IDs of the software dependencies.
    /// @return tokenId The ID of the newly minted token.
    function mintSoftware(
        string memory _tokenURI,
        address[] memory addresses,
        uint256[][] memory _tokenIds
    ) public returns (uint256) {
        if (msg.sender != developer) revert notAuthorized();

        // verify licenses for dependencies
        verifyLicenses(addresses, _tokenIds);

        softwareMeta[softwareCount] = SoftwareMeta({
            creator: developer,
            tokenURI: _tokenURI,
            deps: addresses,
            depTokenIds: _tokenIds
        });
        softwareCount++;
        safeMint(developer, softwareCount, addresses, _tokenIds);
        setTokenURI(developer, softwareCount, _tokenURI);
        // Emit event for reference creation
        emit ReferenceCreated(softwareCount, addresses, _tokenIds);
        return softwareCount;
    }

    function verifyLicenses(
        address[] memory repositories,
        uint256[][] memory tokenIds
    ) internal view {
        if (repositories.length != tokenIds.length)
            revert invalidDependencyArrays();

        IRegistry registry = IRegistry(owner);
        address licenseManagerAddress = registry.getLicenseManager();
        ILicenseManager licenseManager = ILicenseManager(licenseManagerAddress);

        // Check each repository and its tokens
        for (uint256 i = 0; i < repositories.length; i++) {
            address repositoryAddress = repositories[i];

            // Skip if empty repository (no dependencies from this repo)
            if (repositoryAddress == address(0)) continue;

            // Check each token ID for this repository
            for (uint256 j = 0; j < tokenIds[i].length; j++) {
                uint256 tokenId = tokenIds[i][j];

                // Skip self-references (own software doesn't need a license)
                if (
                    repositoryAddress == address(this) &&
                    tokenId <= softwareCount &&
                    softwareMeta[tokenId - 1].creator == developer
                ) {
                    continue;
                }

                // Check if developer has a license using LicenseManager interface
                bool hasValidLicense = licenseManager.hasLicense(
                    developer,
                    repositoryAddress,
                    tokenId
                );

                // Revert if no license is found
                if (!hasValidLicense) {
                    revert missingLicenses(repositoryAddress, tokenId);
                }
            }
        }
    }

    function getOwner() public view returns (address) {
        return owner;
    }

    function getDeveloper() public view returns (address) {
        return developer;
    }

    /// @notice Get the software URI for a specified token ID
    /// @param tokenId the ID of the software token
    /// @return The URI string for the software
    function getSoftwareURI(
        uint256 tokenId
    ) public view returns (string memory) {
        if (!_exists(tokenId)) revert softwareDoesNotExist();
        return tokenURI(tokenId);
    }

    /// @notice Get dependencies for a software token
    /// @param tokenId the ID of the software token
    /// @return deps array of dependecy contract addresses
    /// @return depTokenIds the array of dependency token IDs
    function getSoftwareDependencies(
        uint256 tokenId
    )
        public
        view
        returns (address[] memory deps, uint256[][] memory depTokenIds)
    {
        if (!_exists(tokenId)) revert softwareDoesNotExist();
        return (
            softwareMeta[tokenId - 1].deps,
            softwareMeta[tokenId - 1].depTokenIds
        );
    }
}
