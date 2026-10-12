// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
// Disposable local EVM fixture, NOT Circle USDC and never a deployable Dispatch feature.
// It exercises EIP-3009 signature/nonce/event semantics; no token balances or real value.
contract TokenFixture {
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Transfer(address indexed from, address indexed to, uint256 value);
    function name() public pure returns (string memory) { return "USD Coin"; }
    function version() public pure returns (string memory) { return "2"; }
    function decimals() public pure returns (uint8) { return 6; }
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("USD Coin"), keccak256("2"), block.chainid, address(this)));
    }
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) public {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "window");
        require(!authorizationState[from][nonce], "used");
        bytes32 body = keccak256(abi.encode(keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
            from, to, value, validAfter, validBefore, nonce));
        require(from != address(0) && ecrecover(keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR(), body)), v, r, s) == from, "signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce); emit Transfer(from, to, value);
    }
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) public {
        bytes32 body = keccak256(abi.encode(keccak256("CancelAuthorization(address authorizer,bytes32 nonce)"), authorizer, nonce));
        require(authorizer != address(0) && !authorizationState[authorizer][nonce], "used");
        require(ecrecover(keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR(), body)), v, r, s) == authorizer, "signature");
        authorizationState[authorizer][nonce] = true; emit AuthorizationCanceled(authorizer, nonce);
    }
}
