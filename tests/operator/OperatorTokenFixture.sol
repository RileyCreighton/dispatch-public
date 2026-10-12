// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import "BuyerTokenFixture.sol";
// Generated disposable balances only; never deployed outside the local non-forked EVM.
contract OperatorTokenFixture is BuyerTokenFixture {
    uint256 public fixtureMode;
    function fixtureSetMode(uint256 mode) external {fixtureMode=mode;}
    function transfer(address to,uint256 amount) external returns(bool) {
        require(fixtureMode!=1,"fixture revert");
        require(balanceOf[msg.sender]>=amount,"balance");
        balanceOf[msg.sender]-=amount;balanceOf[to]+=amount;
        if(fixtureMode==6){new WrongEmitter().send(msg.sender,to,amount);return true;}
        emit Transfer(fixtureMode==3?address(0x99):msg.sender,fixtureMode==4?address(0x99):to,fixtureMode==5?amount+1:amount);
        if(fixtureMode==2)emit Transfer(msg.sender,to,amount);
        return true;
    }
}
contract WrongEmitter {event Transfer(address indexed from,address indexed to,uint256 value);function send(address from,address to,uint256 amount) external {emit Transfer(from,to,amount);}}
