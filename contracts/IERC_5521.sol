// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IERC_5521 is IERC165 {

    /// Logged when a node in the rNFT gets referred and changed.
    /// @notice Emitted when the `node` (i.e., an rNFT) is changed.
    event UpdateNode(uint256 indexed tokenId, 
                     address indexed owner, 
                     address[] _address_referringList,
                     uint256[][] _tokenIds_referringList,
                     address[] _address_referredList,
                     uint256[][] _tokenIds_referredList
    );

    // @notice set the referred list of an rNFT associated with different contract addresses and update the referring list of each one in the referred list. Checking the duplication of `addresses` and `tokenIds` is **RECOMMENDED**.
    // @param `tokenId` of rNFT being set. `addresses` of the contracts in which rNFTs with `tokenIds` being referred accordingly. 
    // @requirement 
    /// - the size of `addresses` **MUST** be the same as that of `tokenIds`;
    /// - once the size of `tokenIds` is non-zero, the inner size **MUST** also be non-zero;
    /// - the `tokenId` **MUST** be unique within the same contract;
    /// - the `tokenId` **MUST NOT** be the same as `tokenIds[i][j]` if `addresses[i]` is essentially `address(this)`.
    function setNode(uint256 tokenId, address[] memory addresses, uint256[][] memory tokenIds) external;

    /// @notice get the referring list of an rNFT.
    /// @param `tokenId` of the rNFT being focused, `_address` of contract address associated with the focused rNFT.
    /// @return the referring mapping of the rNFT.
    function referringOf(address _address, uint256 tokenId) external view returns(address[] memory, uint256[][] memory);

    /// @notice get the referred list of an rNFT.
    /// @param `tokenId` of the rNFT being focused, `_address` of contract address associated with the focused rNFT.
    /// @return the referred mapping of the rNFT.
    function referredOf(address _address, uint256 tokenId) external view returns(address[] memory, uint256[][] memory);

    /// @notice get the timestamp of an rNFT when is being created.
    /// @param `tokenId` of the rNFT being focused, `_address` of contract address associated with the focused rNFT.
    /// @return the timestamp of the rNFT when is being created with uint256 format.
    function createdTimestampOf(address _address, uint256 tokenId) external view returns(uint256);
    
    /// @notice check supported interfaces, adhereing to ERC165.
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface TargetContract is IERC165 {
    // @notice set the referred list of an rNFT associated with external contract addresses. 
    // @param `_tokenIds` of rNFTs associated with the contract address `_address` being referred by the rNFT with `tokenId`.
    // @requirement
    /// - `_address` **MUST NOT** be the same as `address(this)` where `this` is executed by an external contract where `TargetContract` interface is implemented.
    function setNodeReferredExternal(address _address, uint256 tokenId, uint256[] memory _tokenIds) external;

    function referringOf(address _address, uint256 tokenId) external view returns(address[] memory, uint256[][] memory);

    function referredOf(address _address, uint256 tokenId) external view returns(address[] memory, uint256[][] memory);

    function createdTimestampOf(address _address, uint256 tokenId) external view returns(uint256);
    
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}