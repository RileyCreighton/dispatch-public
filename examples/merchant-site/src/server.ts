import { createServer } from 'node:http';
import { uuid } from '../../../packages/domain/src/payment.js';
export function merchantSite(options:{port:number;dispatchOrigin?:string;product?:string}) {
 let link='';
 if(options.dispatchOrigin&&options.product){const u=new URL(options.dispatchOrigin);if(u.protocol!=='https:'||u.origin!==options.dispatchOrigin)throw new Error('invalid_link');
  link=`<a href="${u.origin}/buy/${uuid(options.product)}">Pay with USDC through Dispatch</a>`;}
 const page=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fieldnotes Studio</title>
 <style>*{box-sizing:border-box}body{margin:0;background:#f6f4ee;color:#26332b;font:18px/1.6 system-ui}main{max-width:920px;margin:0 auto;padding:40px 24px}h1{font:500 clamp(32px,6vw,64px)/1.1 Georgia,serif}form{max-width:520px;padding:28px;background:white;border:1px solid #cbd0c8;border-radius:12px}label,input,button{display:block;width:100%}input,button{font:inherit;padding:12px;border:1px solid #73816d;border-radius:5px}button{margin-top:20px;background:#304d3b;color:white;cursor:pointer}a{color:#304d3b}aside{min-height:100px;padding-top:24px}small{font-size:14px}</style>
 <main><p>FIELDNOTES STUDIO</p><h1>Useful notes for thoughtful work.</h1><p>A small digital guide for independent makers.</p>
 <form action="/ordinary-checkout" method="post"><h2>Our ordinary checkout</h2><label for="name">Name for your order</label><input id="name" name="name" required minlength="2" maxlength="80" autocomplete="name"><button type="submit">Continue ordinary checkout</button><small>Local demonstration. No card details or money are collected.</small></form>
 <aside aria-label="Optional payment method">${link}</aside><p>Digital edition · no physical shipping.</p></main></html>`;
 const server=createServer({maxHeaderSize:8192,requestTimeout:5000},async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
  if(req.method==='POST'&&req.url==='/ordinary-checkout'){
   if(req.headers['content-type']!=='application/x-www-form-urlencoded'){res.writeHead(415).end();return;}
   let body='';for await(const chunk of req){body+=String(chunk);if(body.length>1024){res.writeHead(413).end();return;}}
   const name=new URLSearchParams(body).get('name');if(!name||name.length<2||name.length>80){res.writeHead(422).end('Enter your name.');return;}
   res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('Ordinary checkout accepted. Local demonstration only.');return;
  }res.writeHead(404).end();
 });server.listen(options.port,'127.0.0.1');return server;
}
