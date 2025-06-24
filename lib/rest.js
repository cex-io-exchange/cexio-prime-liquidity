const fetch = require('node-fetch')
const crypto = require('crypto')
const https = require('https')

class RestClient {
  constructor (apiKey, apiSecret, _options = {}) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.isPublicClient = false

    let options = _options
    if (arguments.length === 1) {
      options = arguments[0]
      this.isPublicClient = true
    }

    this.options = Object.assign({
      log: () => {},
      apiLimit: 300,
      timeout: 30000,
      rejectUnauthorized: true,
      apiUrl: 'https://liquidity.prime.cex.io/api/rest/',
      apiUrlPublic: 'https://liquidity.prime.cex.io/api/rest-public/'
    }, options)

    this.httpsAgent = new https.Agent({
      rejectUnauthorized: this.options.rejectUnauthorized,
      timeout: this.options.timeout
    })

    if (!this.options.apiUrl.endsWith('/')) {
      this.options.apiUrl = `${this.options.apiUrl}/`
    }
    if (!this.options.apiUrlPublic.endsWith('/')) {
      this.options.apiUrlPublic = `${this.options.apiUrlPublic}/`
    }
  }

  callPublic (action, params = {}) {
    const headers = { 'Content-type': 'application/json' }
    return this._request(action, params, headers, 'POST', true)
  }

  callPrivate (action, params = {}, method = 'POST', { onBehalfOfUserId } = {}) {
    if (this.isPublicClient) {
      throw new Error('Attempt to call private method on public client')
    }

    const timestamp = this._unixTime()
    const signatureParams = JSON.stringify(params)
    const signature = this._getSignature(action, timestamp, signatureParams)

    const headers = {
      'X-AGGR-KEY': this.apiKey,
      'X-AGGR-TIMESTAMP': timestamp,
      'X-AGGR-SIGNATURE': signature,
      'Content-Type': 'application/json'
    }

    if (onBehalfOfUserId) {
      headers['X-ON-BEHALF-OF-USER-ID'] = onBehalfOfUserId
    }

    return this._request(action, params, headers, 'POST')
  }

  _unixTime () {
    return Math.floor(Date.now() / 1000)
  }

  _getSignature (action, timestamp, params) {
    const data = action + timestamp + params
    this.options.log('signature params:', data)
    return crypto.createHmac('sha256', this.apiSecret).update(data).digest('base64')
  }

  _limitReached () {
    return false
  }

  async _request (
    action,
    body = {},
    headers = {},
    method = 'GET',
    isPublicRequest = false
  ) {
    if (this._limitReached()) {
      throw new Error(
        'Internal API call rate limit reached.',
        `Limit: ${this.options.apiLimit}`
      )
    }

    const endpoint = isPublicRequest
      ? this.options.apiUrlPublic
      : this.options.apiUrl

    const url = method === 'GET'
      ? `${endpoint}${action}?${new URLSearchParams(body)}`
      : `${endpoint}${action}`

    const req = {
      method,
      headers,
      agent: this.httpsAgent
    }


   if (method === 'POST') {
      req.body = JSON.stringify(body)
    }

    this.options.log(`Request: ${method} ${url}, ${JSON.stringify(req.body)}`)

    try {
      const response = await fetch(url, req)
      const body = await response.json()

      this.options.log(
        `Response: ${req.method} ${url},`,
        `statusCode: ${response.status},`,
        'body:', body
      )

      return this._parseResponse(response, body)
    } catch (err) {
      this.options.log(`Error: ${req.method} ${url}, err:`, err)
      throw err
    }
  }

  _parseResponse (response, body) {
    if (response.status !== 200) {
      let errorObject

      if (typeof body === 'object') {
        errorObject = body
        errorObject.statusCode = response.status
      } else {
        errorObject = { statusCode: response.status, body }
      }

      throw errorObject
    }

    const result = body

    if (result.error) {
      throw result
    }

    return result
  }
}

module.exports = RestClient
