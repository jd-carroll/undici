'use strict'

const { Writable } = require('stream')
const { parserStates, opcodes, states } = require('./constants')
const { kReadyState, kSentClose, kResponse, kReceivedClose } = require('./symbols')
const { isValidStatusCode, failWebsocketConnection, websocketMessageReceived } = require('./util')
const { WebsocketFrameSend } = require('./frame')

class ByteParser extends Writable {
  #buffers = []
  #byteOffset = 0

  #state = parserStates.INFO

  #info = {}

  constructor (ws) {
    super()

    this.ws = ws
  }

  /**
   * @param {Buffer} chunk
   * @param {() => void} callback
   */
  _write (chunk, _, callback) {
    this.#buffers.push(chunk)
    this.#byteOffset += chunk.length

    this.run(callback)
  }

  /**
   * Runs whenever a new chunk is received.
   * Callback is called whenever there are no more chunks buffering,
   * or not enough bytes are buffered to parse.
   */
  run (callback) {
    if (this.#state === parserStates.INFO) {
      // If there aren't enough bytes to parse the payload length, etc.
      if (this.#byteOffset < 2) {
        return callback()
      }

      const buffer = Buffer.concat(this.#buffers, this.#byteOffset)

      this.#info.fin = (buffer[0] & 0x80) !== 0
      this.#info.opcode = buffer[0] & 0x0F

      const fragmented = !this.#info.fin && this.#info.opcode !== opcodes.CONTINUATION

      if (fragmented && this.#info.opcode !== opcodes.BINARY && this.#info.opcode !== opcodes.TEXT) {
        // Only text and binary frames can be fragmented
        failWebsocketConnection(this.ws, 'Invalid frame type was fragmented.')
        return
      }

      const payloadLength = buffer[1] & 0x7F

      if (payloadLength <= 125) {
        this.#info.payloadLength = payloadLength
        this.#state = parserStates.READ_DATA
      } else if (payloadLength === 126) {
        this.#state = parserStates.PAYLOADLENGTH_16
      } else if (payloadLength === 127) {
        this.#state = parserStates.PAYLOADLENGTH_64
      }

      if (
        (this.#info.opcode === opcodes.PING ||
          this.#info.opcode === opcodes.PONG ||
          this.#info.opcode === opcodes.CLOSE) &&
        payloadLength > 125
      ) {
        // Control frames can have a payload length of 125 bytes MAX
        failWebsocketConnection(this.ws, 'Payload length for control frame exceeded 125 bytes.')
        return
      } else if (this.#info.opcode === opcodes.CLOSE) {
        if (payloadLength === 1) {
          failWebsocketConnection(this.ws, 'Received close frame with a 1-byte body.')
          return
        }

        const body = buffer.subarray(2, payloadLength + 2)

        this.#info.closeInfo = this.parseCloseBody(false, body)

        if (!this.ws[kSentClose]) {
          // If an endpoint receives a Close frame and did not previously send a
          // Close frame, the endpoint MUST send a Close frame in response.  (When
          // sending a Close frame in response, the endpoint typically echos the
          // status code it received.)
          const body = Buffer.allocUnsafe(2)
          body.writeUInt16BE(this.#info.closeInfo.code, 0)
          const closeFrame = new WebsocketFrameSend(body)

          this.ws[kResponse].socket.write(
            closeFrame.createFrame(opcodes.CLOSE),
            (err) => {
              if (!err) {
                this.ws[kSentClose] = true
              }
            }
          )
        }

        // Upon either sending or receiving a Close control frame, it is said
        // that _The WebSocket Closing Handshake is Started_ and that the
        // WebSocket connection is in the CLOSING state.
        this.ws[kReadyState] = states.CLOSING

        this.ws[kReceivedClose] = true

        return
      }

      // TODO: handle control frames here. Since they are unfragmented, and can
      // be sent in the middle of other frames, we shouldn't parse them as normal.

      this.#buffers = [buffer.subarray(2)]
      this.#byteOffset -= 2
    } else if (this.#state === parserStates.PAYLOADLENGTH_16) {
      if (this.#byteOffset < 2) {
        return callback()
      }

      const buffer = Buffer.concat(this.#buffers, this.#byteOffset)

      // TODO: optimize this
      this.#info.payloadLength = buffer.subarray(0, 2).readUInt16BE(0)
      this.#state = parserStates.READ_DATA

      this.#buffers = [buffer.subarray(2)]
      this.#byteOffset -= 2
    } else if (this.#state === parserStates.PAYLOADLENGTH_64) {
      if (this.#byteOffset < 8) {
        return callback()
      }

      const buffer = Buffer.concat(this.#buffers, this.#byteOffset)

      // TODO: optimize this
      this.#info.payloadLength = buffer.subarray(0, 8).readBigUint64BE(0)
      this.#state = parserStates.READ_DATA

      this.#buffers = [buffer.subarray(8)]
      this.#byteOffset -= 8
    } else if (this.#state === parserStates.READ_DATA) {
      if (this.#byteOffset < this.#info.payloadLength) {
        // If there is still more data in this chunk that needs to be read
        return callback()
      } else if (this.#byteOffset >= this.#info.payloadLength) {
        // If the server sent multiple frames in a single chunk
        const buffer = Buffer.concat(this.#buffers, this.#byteOffset)

        this.#info.data = buffer.subarray(0, this.#info.payloadLength)

        if (this.#byteOffset > this.#info.payloadLength) {
          this.#buffers = [buffer.subarray(this.#info.data.length)]
          this.#byteOffset -= this.#info.data.length
        } else {
          this.#buffers.length = 0
          this.#byteOffset = 0
        }

        websocketMessageReceived(this.ws, this.#info.opcode, this.#info.data)

        this.#info = {}
        this.#state = parserStates.INFO
      }
    }

    if (this.#byteOffset > 0) {
      return this.run(callback)
    } else {
      callback()
    }
  }

  parseCloseBody (onlyCode, data) {
    // https://datatracker.ietf.org/doc/html/rfc6455#section-7.1.5
    /** @type {number|undefined} */
    let code

    if (data.length >= 2) {
      // _The WebSocket Connection Close Code_ is
      // defined as the status code (Section 7.4) contained in the first Close
      // control frame received by the application
      code = data.readUInt16BE(0)
    }

    if (onlyCode) {
      if (!isValidStatusCode(code)) {
        return null
      }

      return { code }
    }

    // https://datatracker.ietf.org/doc/html/rfc6455#section-7.1.6
    /** @type {Buffer} */
    let reason = data.subarray(2)

    // Remove BOM
    if (reason[0] === 0xEF && reason[1] === 0xBB && reason[2] === 0xBF) {
      reason = reason.subarray(3)
    }

    if (code !== undefined && !isValidStatusCode(code)) {
      return null
    }

    try {
      // TODO: optimize this
      reason = new TextDecoder('utf-8', { fatal: true }).decode(reason)
    } catch {
      return null
    }

    return { code, reason }
  }

  get closingInfo () {
    return this.#info.closeInfo
  }
}

module.exports = {
  ByteParser
}
