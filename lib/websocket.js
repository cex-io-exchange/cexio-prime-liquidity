const WebSocket = require('ws')
const crypto = require('crypto')

class WebsocketClient {
  constructor (apiKey, apiSecret, _options = {}) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret

    this.oidSeqId = 0
    this.handlers = []
    this.waitForResp = []
    this.waitTimers = []
    this.isAuthorized = false
    this.isPublicClient = false

    let options = _options
    if (arguments.length === 1) {
      options = arguments[0]
      this.isPublicClient = true
    }

    this.options = Object.assign({
      log: () => {},
      wsReplyTimeout: 30000,
      rejectUnauthorized: true,
      apiUrl: 'https://liquidity.prime.cex.io/api/ws',
      apiUrlPublic: 'https://liquidity.prime.cex.io/api/ws-public'
    }, options)
  }

  /**
   * Esteblish connection to server and add handlers
   * @param {function} onClose callback on socket close
   * @param {function} onError callback on socket error
   */
  connect (onClose, onError) {
    return new Promise((resolve, reject) => {
      const urlToConnect = this.isPublicClient
        ? this.options.apiUrlPublic
        : this.options.apiUrl

      this.options.log('connecting to:', urlToConnect)

      this.socket = new WebSocket(
        urlToConnect,
        null,
        { rejectUnauthorized: this.options.rejectUnauthorized }
      )

      this._addHandler('disconnected', () => {
        this.isAuthorized = false
        this._cancelAllOidReplies('disconnected from server')
      })

      this._addHandler('connected', async () => {
        try {
          if (!this.isPublicClient) {
            await this._auth()
          }
          resolve()
        } catch (err) {
          reject(err)
        }
      })

      this.socket.on('message', this._handleMessage.bind(this))

      this.socket.on('close', (err) => {
        delete this.socket
        this.isAuthorized = false
        this._cancelAllOidReplies(err)
        reject(err)
        if (onClose) onClose(err)
      })

      this.socket.on('error', (err) => {
        delete this.socket
        this._cancelAllOidReplies(err)
        reject(err)
        if (onError) onError(err)
      })
    })
  }

  /**
   * Close connection to api server
   */
  disconnect () {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close()
    }
  }

  _createSignature (timestamp) {
    const data = `${timestamp}${this.apiKey}`
    return crypto.createHmac('sha256', this.apiSecret).update(data).digest('hex')
  }

  _auth () {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return reject(new Error('Client is not connected'))
      }

      this._addHandler('auth', (authRes) => {
        if (authRes.data.ok && authRes.data.ok === 'ok') {
          this.isAuthorized = true
          resolve()
        } else {
          reject(new Error(`Authorization failure: ${authRes.data.error}`))
        }
      })

      const timestamp = Date.now() / 1000

      const authRequest = JSON.stringify({
        e: 'auth',
        auth: {
          key: this.apiKey,
          signature: this._createSignature(timestamp),
          timestamp: timestamp
        },
        oid: 'auth'
      })

      this.socket.send(authRequest, (err) => {
        if (err) reject(err)
      })
    })
  }

  _handleMessage (dataStr) {
    this.options.log('incoming message:', dataStr)
    const message = JSON.parse(dataStr)

    if (this.handlers[message.e]) {
      this.handlers[message.e](message)
    } else if (message.oid) {
      this._handleOidReply(message)
    } else {
      if (message.e === 'pong') return
      this.options.log('Ignoring ws message because of unknown message format', message)
    }
  }

  _handleOidReply (message) {
    if (this.waitForResp[message.oid] === undefined) {
      this.options.log(
        'Got message from server with oid but without handler on client side.',
        message,
        'Response handlers:',
        Object.keys(this.waitForResp)
      )
      return
    }

    const p = this.waitForResp[message.oid]
    delete this.waitForResp[message.oid]
    clearTimeout(this.waitTimers[message.oid])

    if (message.ok === 'ok') {
      p.resolve(message.data)
    } else {
      p.reject(message.data.error)
    }
  }

  _cancelAllOidReplies (err) {
    Object.keys(this.waitForResp).forEach(oid => {
      this.waitForResp[oid].reject({
        oid,
        error: err || 'connection closed',
        unexpectedError: true
      })
      delete this.waitForResp[oid]
      clearTimeout(this.waitTimers[oid])
    })
  }

  _cancelOidReply (oid, reason) {
    if (this.waitForResp[oid]) {
      this.waitForResp[oid].reject({
        oid,
        error: reason,
        unexpectedError: true
      })
      delete this.waitForResp[oid]
    }
    if (this.waitTimers[oid]) {
      clearTimeout(this.waitTimers[oid])
    }
  }

  /**
   * Subscribe to events about account or order updates
   * @param {string} event account_update || executionReport
   * @param {function} callback function to receive updates messages
   */
  subscribe (event, callback) {
    this._addHandler(event, callback)
  }

  _addHandler (event, callback) {
    this.handlers[event] = callback
  }

  _getDefer () {
    const defer = {}
    defer.promise = new Promise((resolve, reject) => {
      defer.resolve = resolve
      defer.reject = reject
    })
    return defer
  }

  async ping () {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected')
    }

    this.socket.send('{"e": "ping"}')
  }

  async callPublic (method, params) {
    if (!this.isPublicClient) {
      throw new Error('Attempt to call public method on private client')
    }

    return this._callRequest(method, params)
  }

  async callPrivate (method, params) {
    if (this.isPublicClient) {
      throw new Error('Attempt to call private method on public client')
    }

    if (!this.isAuthorized) {
      throw new Error('Not authorized')
    }

    return this._callRequest(method, params)
  }

  async _callRequest (method, params) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected')
    }

    const oid = `${Date.now()}${++this.oidSeqId}_${method}`
    this.waitForResp[oid] = this._getDefer()

    // reject after some timeout if no respone received
    this.waitTimers[oid] = setTimeout(
      () => this._cancelOidReply(oid, 'request timeout'),
      this.options.wsReplyTimeout
    )

    var msg = JSON.stringify({
      e: method,
      data: params,
      oid: oid
    })

    this.options.log('sending message:', msg)

    this.socket.send(msg, (err) => {
      if (err) {
        delete this.waitForResp[oid]
        this.waitForResp[oid].reject(err)
      }
    })

    return this.waitForResp[oid].promise
  }
}

module.exports = WebsocketClient
