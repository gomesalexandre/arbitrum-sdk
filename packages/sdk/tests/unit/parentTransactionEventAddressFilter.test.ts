/*
 * Copyright 2021, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint-env node */
'use strict'

import { utils } from 'ethers'
import { expect } from 'chai'
import { parseTypedLog, parseTypedLogs } from '../../src/lib/dataEntities/event'
import { Bridge__factory } from '../../src/lib/abi/factories/Bridge__factory'
import { Inbox__factory } from '../../src/lib/abi/factories/Inbox__factory'
import { ParentTransactionReceipt } from '../../src/lib/message/ParentTransaction'
import { TransactionReceipt } from '@ethersproject/providers'

const REAL_BRIDGE_ADDRESS = '0x0000000000000000000000000000000000000B01'
const REAL_INBOX_ADDRESS = '0x0000000000000000000000000000000000000B02'
// An unrelated contract, invoked in the same transaction, that emits a log
// whose topic0 happens to match MessageDelivered/InboxMessageDelivered's
// signature but is not actually the real Bridge/Inbox.
const ATTACKER_ADDRESS = '0x000000000000000000000000000000000000eeee'

const bridgeIface = Bridge__factory.createInterface()
const inboxIface = Inbox__factory.createInterface()

function topicPad(value: string): string {
  return utils.hexZeroPad(value, 32)
}

function makeMessageDeliveredLog(address: string, messageIndex: number) {
  return {
    blockNumber: 1,
    blockHash: topicPad('0x1'),
    transactionIndex: 0,
    removed: false,
    address,
    data: utils.defaultAbiCoder.encode(
      ['address', 'uint8', 'address', 'bytes32', 'uint256', 'uint64'],
      [
        REAL_INBOX_ADDRESS,
        9, // InboxMessageKind.L1MessageType_ethDeposit
        '0x0000000000000000000000000000000000000009', // spoofed sender
        topicPad('0x0'),
        0,
        0,
      ]
    ),
    topics: [
      bridgeIface.getEventTopic('MessageDelivered'),
      topicPad(utils.hexlify(messageIndex)),
      topicPad('0x0'),
    ],
    transactionHash: topicPad('0x2'),
    logIndex: 0,
  }
}

function makeInboxMessageDeliveredLog(address: string, messageNum: number) {
  return {
    blockNumber: 1,
    blockHash: topicPad('0x1'),
    transactionIndex: 0,
    removed: false,
    address,
    data: utils.defaultAbiCoder.encode(['bytes'], ['0x']),
    topics: [
      inboxIface.getEventTopic('InboxMessageDelivered'),
      topicPad(utils.hexlify(messageNum)),
    ],
    transactionHash: topicPad('0x2'),
    logIndex: 1,
  }
}

describe('parseTypedLog/parseTypedLogs address scoping', () => {
  it('accepts a matching-topic log from any address when no expectedAddress is given (back-compat)', () => {
    const log = makeMessageDeliveredLog(ATTACKER_ADDRESS, 0)
    const result = parseTypedLog(Bridge__factory, log, 'MessageDelivered')
    expect(result).to.not.equal(null)
  })

  it('rejects a matching-topic log from an unexpected address when expectedAddress is given', () => {
    const log = makeMessageDeliveredLog(ATTACKER_ADDRESS, 0)
    const result = parseTypedLog(
      Bridge__factory,
      log,
      'MessageDelivered',
      REAL_BRIDGE_ADDRESS
    )
    expect(result).to.equal(null)
  })

  it('accepts a matching-topic log from the expected address', () => {
    const log = makeMessageDeliveredLog(REAL_BRIDGE_ADDRESS, 0)
    const result = parseTypedLog(
      Bridge__factory,
      log,
      'MessageDelivered',
      REAL_BRIDGE_ADDRESS
    )
    expect(result).to.not.equal(null)
  })

  it('parseTypedLogs filters out spoofed logs from an unexpected address', () => {
    const logs = [
      makeMessageDeliveredLog(REAL_BRIDGE_ADDRESS, 0),
      makeMessageDeliveredLog(ATTACKER_ADDRESS, 1),
    ]
    const results = parseTypedLogs(
      Bridge__factory,
      logs,
      'MessageDelivered',
      REAL_BRIDGE_ADDRESS
    )
    expect(results.length).to.equal(1)
  })
})

describe('ParentTransactionReceipt event address scoping', () => {
  function buildReceipt(logs: unknown[]): ParentTransactionReceipt {
    return new ParentTransactionReceipt({
      logs,
    } as unknown as TransactionReceipt)
  }

  it('getMessageDeliveredEvents includes a spoofed log when no address is given (documents the previously-unscoped default)', () => {
    const receipt = buildReceipt([makeMessageDeliveredLog(ATTACKER_ADDRESS, 0)])
    expect(receipt.getMessageDeliveredEvents().length).to.equal(1)
  })

  it('getMessageDeliveredEvents excludes a spoofed log when the real bridge address is given', () => {
    const receipt = buildReceipt([makeMessageDeliveredLog(ATTACKER_ADDRESS, 0)])
    expect(
      receipt.getMessageDeliveredEvents(REAL_BRIDGE_ADDRESS).length
    ).to.equal(0)
  })

  it('getInboxMessageDeliveredEvents excludes a spoofed log when the real inbox address is given', () => {
    const receipt = buildReceipt([
      makeInboxMessageDeliveredLog(ATTACKER_ADDRESS, 0),
    ])
    expect(
      receipt.getInboxMessageDeliveredEvents(REAL_INBOX_ADDRESS).length
    ).to.equal(0)
  })

  it('getMessageEvents excludes a spoofed MessageDelivered/InboxMessageDelivered pair when real addresses are given, but includes it when omitted', () => {
    const logs = [
      makeMessageDeliveredLog(ATTACKER_ADDRESS, 0),
      makeInboxMessageDeliveredLog(ATTACKER_ADDRESS, 0),
    ]
    const receipt = buildReceipt(logs)

    // Unscoped (previous default behavior): the forged pair is accepted.
    expect(receipt.getMessageEvents().length).to.equal(1)

    // Scoped to the real bridge/inbox addresses: the forged pair - which
    // matches on topic and messageIndex/messageNum but was emitted by an
    // unrelated contract - is correctly rejected by both sides, so no pair
    // is formed at all (rather than throwing a count-mismatch error).
    expect(
      receipt.getMessageEvents(REAL_BRIDGE_ADDRESS, REAL_INBOX_ADDRESS).length
    ).to.equal(0)
  })
})
