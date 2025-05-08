// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.4;

import "./Repository.sol";
import "./LicenseManager.sol";

/// @title Registry
/// @notice This contract manages the registration of developers and their software, allows minting and manages references between software
contract Registry {
    address private immutable owner;
    uint256 private repositoryCounter;
    address private immutable licenseManager;
    address marketplace;

    // array of developer contracts
    mapping(address => bool) private repositories; // saving gas
    // stores wallet Address asociated with developer contract
    mapping(address => address) private walletToRepository;

    // stores developer contract address asociated with software tokenIds
    // mapping(address => uint256[]) private repositoryToTokenIds;
    // For optimal gas usage, we will query the repository contract for the token IDs

    // Event to emit when minted a software
    event SoftwareMinted(address indexed developer, uint256 indexed softwareId, string tokenURI);
    event RepositoryCreated(address indexed developer, address indexed repository);
    event LicenseMinted(address indexed buyer, address indexed repository, uint256 indexed softwareId, uint256 licenseId);
    //custom Errors
    error NotContractOwner();
    error NotMarketplace();
    error AlreadyRegistered();
    error NotRegisteredDeveloper();
    error NotRegisteredRepository();
    error DeveloperHasNoRepository();

    constructor() {
        owner = msg.sender;
        repositoryCounter = 0;

        licenseManager = address(new LicenseManager(address(this)));
    }

    function setMarketplace(address _marketplace) external {
        if(msg.sender != owner) revert NotContractOwner();
        marketplace = _marketplace;
    }

    /// @notice Register a new developer/repo contract
    /// @dev This function allows a developer to register their contract/create repo, finally the registry is owner of all other contracts
    // @todo emit eventu ze sa vytvorilo repo done
    function createRepository() public returns (address) {
        if (walletToRepository[msg.sender] != address(0)) revert AlreadyRegistered();

        address newRepository = _createRepositoryContract(msg.sender);
        repositories[newRepository] = true;
        walletToRepository[msg.sender] = newRepository;
        repositoryCounter++;

        emit RepositoryCreated(msg.sender, newRepository);
        return newRepository;
    }

    function _createRepositoryContract(address developer) internal returns (address) {
        return address(new Repository(address(this), developer));
    }

    function getOrCreateRepository() private returns (address) {
        address repoAddress = walletToRepository[msg.sender];

        //if the developer doesn't have a repository, create one
        if (repoAddress == address(0)) {
            repoAddress = createRepository();
        }

        return repoAddress;
    }

    function mintSoftware(string memory _tokenURI, address[] memory addresses, uint256[][] memory _tokenIds)
        external
        returns (uint256)
    {
        address repository = getOrCreateRepository();
        //external call
        uint256 tokenId = Repository(repository).mintSoftware( _tokenURI, addresses, _tokenIds);

        emit SoftwareMinted(msg.sender, tokenId, _tokenURI);
        return tokenId;
    }

    /// @notice Mint a license for a software
    /// @param buyer The address that will own the license
    /// @param developer The developer who listed the software
    /// @param softwareId The ID of the software being licensed
    /// @return licenseId The ID of the newly minted license
    function mintLicense(address buyer, address developer, uint256 softwareId)
        external
        returns (uint256)
    {
        if(msg.sender != marketplace) revert NotMarketplace();

        address repositoryAddress = walletToRepository[developer];
        if(repositoryAddress == address(0)) revert DeveloperHasNoRepository();

        uint256 licenseId = LicenseManager(licenseManager).mintLicense(buyer, repositoryAddress, softwareId);

        emit LicenseMinted(buyer, repositoryAddress, softwareId, licenseId);
        return licenseId;
    }

    function getLicenseManager() external view returns (address) {
        return licenseManager;
    }

    function isRepository(address _repositoryAddress) public view returns (bool) {
        return repositories[_repositoryAddress];
    }

    function isDeveloper(address _sender) external view returns (bool) {
        return walletToRepository[_sender] != address(0);
    }

    function getRepositoryContract(address _sender) external view returns (address) {
        return walletToRepository[_sender];
    }

    /// @notice Check if the repository owns the software
    function repositoryOwnsSoftware(address _repository, uint256 _tokenId) external view returns (bool) {
        if(!repositories[_repository]) revert NotRegisteredRepository();

        Repository repository = Repository(_repository);

        return repository.ownerOf(_tokenId) == repository.getDeveloper();
    }

    function hasLicense(address user, address repository, uint256 softwareId) external view returns (bool) {
        return LicenseManager(licenseManager).hasLicense(user, repository, softwareId);
    }
}
