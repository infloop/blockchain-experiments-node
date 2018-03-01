import * as CryptoJS from 'crypto-js';
import * as express from 'express';
import * as bodyParser from 'body-parser';
import * as WebSocket from 'ws';
import * as yargs from 'yargs';

const http_port = yargs.argv.port || 3001;
const p2p_port = <number> (yargs.argv.p2pport || 6001);
const initialPeers = yargs.argv.peers ? yargs.argv.peers.split(',') : [];

//
// Blockchain part
//

class Block {
    public previousHash: string;
    public hash: string;
    public index: number;
    public timestamp: number;
    public data: any;

    public constructor(index, previousHash, timestamp, data, hash) {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash.toString();
        this.hash = hash.toString();
    }
}

let blockchain: Block[] = [getGenesisBlock()];

function getGenesisBlock(): Block {
    return new Block(0, '0', 1465154705, 'my genesis block!!', '816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7');
}

function getLatestBlock(): Block {
    return blockchain[blockchain.length - 1];
}

function calculateHash(index: number, previousHash: string, timestamp: number, data: string) {
    return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
}

function generateNextBlock(blockData: string) {
    let latestBlock = getLatestBlock();

    let nextBlockIndex = latestBlock.index + 1;
    let nextBlockTimestamp = new Date().getTime() / 1000;
    let nextBlockHash = calculateHash(nextBlockIndex, latestBlock.hash, nextBlockTimestamp, blockData);

    return new Block(nextBlockIndex, latestBlock.hash, nextBlockTimestamp, blockData, nextBlockHash);
}

function calculateHashForBlock(block: Block) {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data);
}

function addBlock(newBlock: Block) {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
}

function isValidNewBlock(newBlock: Block, previousBlock: Block) {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('new block has invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('new block has previousHash');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('new block has invalid hash:' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
}

function replaceChain(newBlocks: Block[]) {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        p2p_broadcast(p2p_responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
}


function isValidChain(blockchainToValidate: Block[]) {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    let tempBlocks = [blockchainToValidate[0]];
    for (let i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
}

//
// P2P part
//
let sockets: WebSocket[] = [];

enum P2PMessageType {
    QUERY_LATEST = 'QUERY_LATEST',
    QUERY_ALL = 'QUERY_ALL',
    RESPONSE_BLOCKCHAIN = 'RESPONSE_BLOCKCHAIN'
}

function p2p_initServer() {
    let server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => p2p_initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);
}

function p2p_initConnection(ws: WebSocket) {
    sockets.push(ws);
    p2p_initMessageHandler(ws);
    p2p_initErrorHandler(ws);
    p2p_write(ws, p2p_queryChainLengthMsg());
}

function p2p_initMessageHandler(ws: WebSocket) {
    ws.on('message', (buffer) => {
        let message = JSON.parse(buffer.toString());
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case P2PMessageType.QUERY_LATEST:
                p2p_write(ws, p2p_responseLatestMsg());
                break;
            case P2PMessageType.QUERY_ALL:
                p2p_write(ws, p2p_responseChainMsg());
                break;
            case P2PMessageType.RESPONSE_BLOCKCHAIN:
                p2p_handleBlockchainResponse(message);
                break;
        }
    });
}

function p2p_initErrorHandler(ws: WebSocket) {
    let closeConnection = (ws: WebSocket) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
}

/**
 * New peers in format:
 *  ws://host.com:port
 *
 * @param {String[]} newPeers
 */
function p2p_connectToPeers(newPeers: string[]) {
    newPeers.forEach((peer) => {
        let ws = new WebSocket(peer);
        ws.on('open', () => p2p_initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
}

function p2p_handleBlockchainResponse(message) {
    let receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    let latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    let latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log('We can append the received block to our chain');
            blockchain.push(latestBlockReceived);
            p2p_broadcast(p2p_responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log('We have to query the chain from our peer');
            p2p_broadcast(p2p_queryAllMsg());
        } else {
            console.log('Received blockchain is longer than current blockchain');
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than current blockchain. Do nothing');
    }
}

function p2p_queryChainLengthMsg() {
    return {
        'type': P2PMessageType.QUERY_LATEST
    };
}

function p2p_queryAllMsg () {
    return {
        'type': P2PMessageType.QUERY_ALL
    };
}

function p2p_responseChainMsg () {
    return {
        'type': P2PMessageType.RESPONSE_BLOCKCHAIN,
        'data': JSON.stringify(blockchain)
    };
}

function p2p_responseLatestMsg() {
    return {
        'type': P2PMessageType.RESPONSE_BLOCKCHAIN,
        'data': JSON.stringify([getLatestBlock()])
    };
}

function p2p_write(ws, message) {
    ws.send(JSON.stringify(message));
}

function p2p_broadcast(message) {
    sockets.forEach(socket => p2p_write(socket, message));
}

p2p_connectToPeers(initialPeers);
p2p_initServer();

//
// HTTP Part
//

function http_initServer() {
    let app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
    app.post('/mineBlock', (req, res) => {
        let newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        p2p_broadcast(p2p_responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.json({msg: 'Block added'});
        res.send();
    });
    app.get('/peers', (req, res) => {
        res.send(sockets.map((s: any) => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.post('/addPeer', (req, res) => {
        p2p_connectToPeers([req.body.peer]);
        res.json({msg: 'Peer added'});
        res.send();
    });
    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
}

http_initServer();