// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.4;

import "./Registry.sol";

/// @title RoyaltyManager
/// @notice Manages royalty distribution with metadata for off-chain calculations
contract RoyaltyManager {
    address private immutable owner;
    Registry private immutable registry;

    // Store pending royalties for each developer
    mapping(address => uint256) public pendingRoyalties;

    // Track software publication data for off-chain royalty calculations
    mapping(address => mapping(uint256 => uint256)) public softwarePublishTime;

    // Events for indexer to track
    event SoftwarePublished(address indexed repository, uint256 indexed softwareId, uint256 publishTime);
    event SaleMade(address indexed repository, uint256 indexed softwareId, uint256 price, uint256 timestamp);
    event RoyaltyAdded(address indexed developer, uint256 amount);
    event RoyaltyWithdrawn(address indexed developer, uint256 amount);
    event RoyaltyParametersUpdated(uint256 initialRate, uint256 decayFactor, uint256 decayPeriod);

    // Errors
    error NotAuthorized();
    error InsufficientRoyalties();
    error TransferFailed();

    constructor(address _registry) {
        owner = msg.sender;
        registry = Registry(_registry);

        // Emit initial royalty parameters for indexer
        emit RoyaltyParametersUpdated(10, 95, 30 days);
    }

    /// @notice Record a software sale (for indexer to calculate royalties off-chain)
    /// @param developer The software developer
    /// @param repository The repository address
    /// @param softwareId The software ID
    /// @param price The sale price
    function recordSale(
        address developer,
        address repository,
        uint256 softwareId,
        uint256 price
    ) external payable {
        // Only the marketplace can record sales
        if (msg.sender != registry.getMarketplace()) revert NotAuthorized();

        // Get or set publish time
        uint256 publishTime = softwarePublishTime[repository][softwareId];
        if (publishTime == 0) {
            publishTime = block.timestamp;
            softwarePublishTime[repository][softwareId] = publishTime;
            emit SoftwarePublished(repository, softwareId, publishTime);
        }

        // Emit sale event for the indexer to process
        emit SaleMade(repository, softwareId, price, block.timestamp);

        // Transfer full payment to developer - royalties will be handled by off-chain service
        pendingRoyalties[developer] += msg.value;
        emit RoyaltyAdded(developer, msg.value);
    }

    /// @notice Allow developers to withdraw their royalties
    function withdrawRoyalties() external {
        uint256 amount = pendingRoyalties[msg.sender];
        if (amount == 0) revert InsufficientRoyalties();

        // Reset pending royalties before transfer to prevent reentrancy
        pendingRoyalties[msg.sender] = 0;

        // Transfer royalties to developer
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit RoyaltyWithdrawn(msg.sender, amount);
    }

    /// @notice Update royalty parameters (owner only)
    /// @dev These parameters are only used off-chain by the indexer
    function updateRoyaltyParameters(
        uint256 _initialRate,
        uint256 _decayFactor,
        uint256 _decayPeriod
    ) external {
        if (msg.sender != owner) revert NotAuthorized();
        emit RoyaltyParametersUpdated(_initialRate, _decayFactor, _decayPeriod);
    }

    /// @notice Add royalties manually (only for off-chain oracle/indexer)
    /// @dev This allows an authorized oracle to adjust royalties based on off-chain calculations
    function addRoyalties(address developer, uint256 amount) external payable {
        // Only owner or oracle can call this
        if (msg.sender != owner) revert NotAuthorized();

        pendingRoyalties[developer] += amount;
        emit RoyaltyAdded(developer, amount);
    }

    /// @notice Get pending royalties for a developer
    function getPendingRoyalties(address developer) external view returns (uint256) {
        return pendingRoyalties[developer];
    }
}
