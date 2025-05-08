// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.4;

import "./Registry.sol";

interface IRoyaltyManager {
  function recordSale (
    address developer,
    address repository,
    uint256 softwareId,
    uint256 softwarePrice
  ) external payable;
}

/// @title IMarketplace
/// @notice Interface for the Marketplace contract
/// @dev This interface defines the core functions that can be called externally
interface IMarketplace {
    /// @notice Check if a software is listed on the marketplace
    /// @param repository The repository contract address
    /// @param tokenId The ID of the software token
    /// @return bool True if the software is listed
    function checkIsListed(address repository, uint256 tokenId) external view returns (bool);

    /// @notice Get the listing price of a software
    /// @param repository The repository contract address
    /// @param tokenId The ID of the software token
    /// @return uint256 The price of the software in wei
    function getListingPrice(address repository, uint256 tokenId) external view returns (uint256);

    /// @notice List a software NFT on the marketplace
    /// @param tokenId The token ID of the software NFT
    /// @param price The price of the software NFT
    function listSoftware(uint256 tokenId, uint256 price) external;

    /// @notice Buy a software license
    /// @param repository The repository contract that owns the software NFT
    /// @param tokenId The token ID of the software NFT
    /// @return licenseId The ID of the newly minted license
    function buySoftware(address repository, uint256 tokenId) external payable returns (uint256);
}

contract Marketplace is IMarketplace {
    Registry private registry;

    struct Listing {
        address developer;
        uint256 price;
    }

    // Custom errors - replacing the modifiers
    error NotSeller();
    error NotListed();
    error AlreadyListed();
    error NotDeveloper();
    error NoRepository();
    error NotOwner();
    error InsufficientFunds();
    error CannotBuyOwnSoftware();

    mapping(address => mapping(uint256 => Listing)) private listings; // repository -> tokenId -> listing

    constructor(address _registry) {
        registry = Registry(_registry);
    }

    // Event to track software listings
    event SoftwareListed(
        address indexed nftContract, uint256 indexed tokenId, address indexed developer, uint256 price
    );
    // Event to track software license purchases
    event LicensePurchased(
        address indexed buyer, address indexed nftContract, uint256 indexed tokenId, uint256 licenseId, uint256 price
    );

    /// @inheritdoc IMarketplace
    function checkIsListed(address repository, uint256 tokenId) external view override returns (bool) {
        return listings[repository][tokenId].price > 0;
    }

    /// @inheritdoc IMarketplace
    function getListingPrice(address repository, uint256 tokenId) external view override returns (uint256) {
        if (listings[repository][tokenId].price == 0) revert NotListed();
        return listings[repository][tokenId].price;
    }

    /// @inheritdoc IMarketplace
    function listSoftware(uint256 tokenId, uint256 listingPrice) external override {
        // Get the developer's repository contract
        address repositoryAddress = registry.getRepositoryContract(msg.sender);

        // Check if already listed - replaces notListed modifier
        if (listings[repositoryAddress][tokenId].price > 0) revert AlreadyListed();

        // Check if the sender is a registered developer
        if (!registry.isDeveloper(msg.sender)) revert NotDeveloper();

        // Check if the developer has a repository
        if (repositoryAddress == address(0)) revert NoRepository();

        // Check if the repository owns the NFT through the Registry
        if (!registry.repositoryOwnsSoftware(repositoryAddress, tokenId)) revert NotOwner();

        // Create the listing
        listings[repositoryAddress][tokenId] = Listing({developer: msg.sender, price: listingPrice});

        // Emit event for the frontend
        emit SoftwareListed(repositoryAddress, tokenId, msg.sender, listingPrice);
    }

    /// @inheritdoc IMarketplace
    function buySoftware(address repository, uint256 tokenId)
        public
        payable
        override
        returns (uint256)
    {
        // Check if listing exists - replaces isListed modifier
        if (listings[repository][tokenId].price == 0) revert NotListed();

        // Check if the buyer is not the seller
        if (listings[repository][tokenId].developer == msg.sender) revert CannotBuyOwnSoftware();

        // Check if the buyer has enough funds
        uint256 price = listings[repository][tokenId].price;
        if (msg.value < price) revert InsufficientFunds();

        address developer = listings[repository][tokenId].developer;

        // Mint a license for the buyer through the Registry
        uint256 licenseId = registry.mintLicense(msg.sender, listings[repository][tokenId].developer, tokenId);

        // Transfer the payment to the developer
        /// @todo az po mint licencie reetrancy-attack / moznoe nejaky withdraw mechanizmus
        // Record sale for off-chain royalty calculations
        address royaltyManagerAddress = registry.getRoyaltyManager();
        IRoyaltyManager royaltyManager = IRoyaltyManager(royaltyManagerAddress);

        royaltyManager.recordSale{value: msg.value}(
            developer,
            repository,
            tokenId,
            price
        );

        // Emit event for the frontend
        emit LicensePurchased(msg.sender, repository, tokenId, licenseId, price);

        return licenseId;
    }

    /// @notice Cancel a software listing
    /// @param repository The repository contract address
    /// @param tokenId The token ID of the software NFT
    function cancelListing(address repository, uint256 tokenId) external {
        // Check if the sender is the seller - replaces isSeller modifier
        if (listings[repository][tokenId].developer != msg.sender) revert NotSeller();

        // Delete the listing
        delete listings[repository][tokenId];
    }
}
