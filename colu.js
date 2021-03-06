var util = require('util')
var events = require('events')
var async = require('async')
var request = require('request')

var HDWallet = require('hdwallet')
var ColoredCoins = require('coloredcoinsd-wraper')

var mainnetColuHost = 'https://engine.colu.co'
var testnetColuHost = 'https://testnet.engine.colu.co'

var FEE = 1000

var Colu = function (settings) {
  var self = this

  settings = settings || {}
  if (settings.network === 'testnet') {
    self.coluHost = settings.coluHost || testnetColuHost
  } else {
    self.coluHost = settings.coluHost || mainnetColuHost
  }
  self.hdwallet = new HDWallet(settings)
  self.coloredCoins = new ColoredCoins(settings)
  self.network = self.hdwallet.network
  self.hdwallet.on('connect', function () {
    self.emit('connect')
  })

  self.hdwallet.on('error', function (err) {
    self.emit('error', err)
  })
}

var askForFinance = function (company_public_key, purpose ,amount, host, cb) {
  var data_params = {
    company_public_key: company_public_key,
    purpose: purpose,
    amount: amount
  }
  request.post(host + '/ask_for_finance', {form: data_params}, cb)
}

util.inherits(Colu, events.EventEmitter)

Colu.prototype.init = function (cb) {
  var self = this
  self.hdwallet.init(cb)
}

Colu.prototype.signAndTransmit = function (txHex, last_txid, host, callback) {
  var self = this

  var addresses = ColoredCoins.getInputAddresses(txHex, self.network)
  async.map(addresses, function (address, cb) {
    self.hdwallet.getAddressPrivateKey(address, cb)
  },
  function (err, privateKeys) {
    if (err) return callback(err)
    var signedTxHex = ColoredCoins.signTx(txHex, privateKeys)
    var data_params = {
      last_txid: last_txid,
      tx_hex: signedTxHex
    }
    request.post(host + '/transmit_financed', {form: data_params }, callback)
  })
}

Colu.prototype.issueAsset = function (args, callback) {
  var self = this

  var privateKey
  var publicKey
  var last_txid
  var assetInfo
  var receivingAddresses
  args.fee = FEE

  async.waterfall([
    // Ask for finance.
    function (cb) {
      if (!args.issueAddress) {
        cb(null, self.hdwallet.getPrivateKey(args.accountIndex))
      } else {
        self.hdwallet.getAddressPrivateKey(args.issueAddress, cb)
      }
    },
    function (priv, cb) {
      privateKey = priv
      publicKey = privateKey.pub
      args.issueAddress = publicKey.getAddress(self.network).toString()

      var sendingAmount = parseInt(args.amount, 10)
      if (args.transfer) {
        args.transfer.forEach(function (to) {
          if (!to.address) {
            to.address = args.issueAddress
          }
          sendingAmount -= parseInt(to.amount, 10)
        })
        if (sendingAmount > 0) {
          args.transfer.push({
            address: args.issueAddress,
            amount: sendingAmount
          })
        }
      } else {
        args.transfer = [{
          address: args.issueAddress,
          amount: sendingAmount
        }]
      }

      var financeAmount = args.fee + (FEE * args.transfer.length)

      askForFinance(publicKey.toHex(), 'Issue', financeAmount, self.coluHost, cb)
    },
    function (response, body, cb) {
      if (response.statusCode !== 200) {
        return cb(body)
      }
      body = JSON.parse(body)
      last_txid = body.txid

      args.financeOutputTxid = last_txid
      args.financeOutput = body.vout
      receivingAddresses = args.transfer
      args.flags = args.flags || {}
      args.flags.injectPreviousOutput = true
      return self.coloredCoins.getIssueAssetTx(args, cb)
    },
    function (l_assetInfo, cb) {
      assetInfo = l_assetInfo
      self.signAndTransmit(assetInfo.txHex, last_txid, self.coluHost, cb)
    },
    function (response, body, cb) {
      if (response.statusCode !== 200) {
        return cb(body)
      }
      // console.log('transmited')
      body = JSON.parse(body)
      assetInfo.txid = body.txid2.txid
      assetInfo.receivingAddresses = receivingAddresses
      assetInfo.issueAddress = args.issueAddress
      cb(null, assetInfo)
    }
  ],
  callback)
}

Colu.prototype.sendAsset = function (args, callback) {
  var self = this

  var privateKey
  var publicKey
  var last_txid
  var sendInfo
  args.fee = args.fee || FEE

  async.waterfall([
    function (cb) {
      self.hdwallet.getAddressPrivateKey(args.from, cb)
    },
    // Ask for finance.
    function (priv, cb) {
      privateKey = priv
      publicKey = privateKey.pub
      var financeAmount
      if (args.to) {
        financeAmount = args.fee + (FEE * args.to.length)
      } else {
        financeAmount = args.fee + FEE
      }

      askForFinance(publicKey.toHex(), 'Send', financeAmount, self.coluHost, cb)
    },
    function (response, body, cb) {
      if (response.statusCode !== 200) {
        return cb(body)
      }
      body = JSON.parse(body)
      last_txid = body.txid
      args.financeOutputTxid = last_txid
      args.financeOutput = body.vout
      args.flags = args.flags || {}
      args.flags.injectPreviousOutput = true
      return self.coloredCoins.getSendAssetTx(args, cb)
    },
    function (l_sendInfo, cb) {
      sendInfo = l_sendInfo
      self.signAndTransmit(sendInfo.txHex, last_txid, self.coluHost, cb)
    },
    function (response, body, cb) {
      if (response.statusCode !== 200) {
        return cb(body)
      }
      // console.log('transmited')
      body = JSON.parse(body)
      sendInfo.txid = body.txid2.txid
      cb(null, sendInfo)
    }
  ],
  callback)
}

module.exports = Colu
