// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import "TokenFixture.sol";
// Generated local-chain balances only, no fork, no funded key, not native USDC.
contract BuyerTokenFixture is TokenFixture {
    mapping(address=>uint256) public balanceOf;
    function fixtureMint(address account,uint256 value) external { balanceOf[account]+=value; }
    function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,
      uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) public override {
        require(balanceOf[from]>=value,"balance");
        super.transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s);
        balanceOf[from]-=value;balanceOf[to]+=value;
    }
}
