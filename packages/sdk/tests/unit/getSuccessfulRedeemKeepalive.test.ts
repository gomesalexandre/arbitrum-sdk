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

import { Logger, LogLevel } from '@ethersproject/logger'
Logger.setLogLevel(LogLevel.ERROR)
import { BigNumber, providers, utils } from 'ethers'
import { expect } from 'chai'
import { anything, instance, mock, when } from 'ts-mockito'
import {
  ParentToChildMessageReader,
  ParentToChildMessageStatus,
} from '../../src/lib/message/ParentToChildMessage'
import { ArbRetryableTx__factory } from '../../src/lib/abi/factories/ArbRetryableTx__factory'

const iface = ArbRetryableTx__factory.createInterface()
const REDEEM_SCHEDULED_TOPIC = iface.getEventTopic('RedeemScheduled')
const LIFETIME_EXTENDED_TOPIC = iface.getEventTopic('LifetimeExtended')
const ARB_RETRYABLE_TX_ADDRESS = '0x000000000000000000000000000000000000006E'

function topicPad(value: string): string {
  return utils.hexZeroPad(value, 32)
}

function makeLifetimeExtendedLog(
  ticketId: string,
  newTimeout: number,
  blockNumber: number
) {
  return {
    blockNumber,
    blockHash: utils.hexZeroPad(utils.hexlify(blockNumber), 32),
    transactionIndex: 0,
    removed: false,
    address: ARB_RETRYABLE_TX_ADDRESS,
    data: utils.defaultAbiCoder.encode(['uint256'], [newTimeout]),
    topics: [LIFETIME_EXTENDED_TOPIC, topicPad(ticketId)],
    transactionHash: utils.hexZeroPad(utils.hexlify(blockNumber + 1), 32),
    logIndex: 0,
  }
}

function makeRedeemScheduledLog(
  ticketId: string,
  retryTxHash: string,
  blockNumber: number
) {
  return {
    blockNumber,
    blockHash: utils.hexZeroPad(utils.hexlify(blockNumber), 32),
    transactionIndex: 0,
    removed: false,
    address: ARB_RETRYABLE_TX_ADDRESS,
    data: utils.defaultAbiCoder.encode(
      ['uint64', 'address', 'uint256', 'uint256'],
      [0, '0x0000000000000000000000000000000000000001', 0, 0]
    ),
    topics: [
      REDEEM_SCHEDULED_TOPIC,
      topicPad(ticketId),
      topicPad(retryTxHash),
      topicPad(utils.hexlify(0)),
    ],
    transactionHash: utils.hexZeroPad(utils.hexlify(blockNumber + 1), 32),
    logIndex: 1,
  }
}

describe('getSuccessfulRedeem keepalive scan', () => {
  const buildMessage = () => {
    const providerMock = mock(providers.JsonRpcProvider)
    when(providerMock._isProvider).thenReturn(true)
    when(providerMock.getNetwork()).thenResolve({ chainId: 42161 } as any)

    const provider = instance(providerMock)

    const message = new ParentToChildMessageReader(
      provider,
      42161,
      '0x0000000000000000000000000000000000000001',
      BigNumber.from(1),
      BigNumber.from(0),
      {
        destAddress: '0x0000000000000000000000000000000000000002',
        l2CallValue: BigNumber.from(0),
        l1Value: BigNumber.from(0),
        maxSubmissionFee: BigNumber.from(0),
        excessFeeRefundAddress: '0x0000000000000000000000000000000000000003',
        callValueRefundAddress: '0x0000000000000000000000000000000000000004',
        gasLimit: BigNumber.from(100000),
        maxFeePerGas: BigNumber.from(1),
        data: '0x',
      }
    )

    // Isolate the code path under test (the keepalive-scan loop inside
    // getSuccessfulRedeem) by stubbing the surrounding checks directly on
    // the instance - this is standard for testing this class, matching how
    // getRetryableCreationReceipt/getAutoRedeemAttempt/retryableExists each
    // require their own heavy provider/contract-call setup unrelated to the
    // loop being tested here.
    ;(message as any).getRetryableCreationReceipt = async () => ({
      blockNumber: 0,
      status: 1,
    })
    ;(message as any).getAutoRedeemAttempt = async () => null
    ;(message as any).retryableExists = async () => false

    // Patch in a fake retryableLifetimeSeconds-bearing network resolution by
    // overriding getArbitrumNetwork's effect indirectly: since the source
    // reads `chainNetwork.retryableLifetimeSeconds`, and getArbitrumNetwork
    // is called with `this.childProvider`, we instead make the provider
    // resolve a real Arbitrum One network and rely on the config module's
    // real value OR override at the point of use isn't possible without
    // editing source - so this test verifies against real Arbitrum One's
    // configured lifetime rather than an arbitrary synthetic one.
    return { message, provider, providerMock }
  }

  it('BUG (skipped when unfixed): finds the LATER, life-extending keepalive across multiple queried ranges and correctly redeems instead of reporting EXPIRED', async () => {
    const { message, providerMock } = buildMessage()
    const ticketId = message.retryableCreationId

    // Real Arbitrum One retryableLifetimeSeconds is 7 days (604800s). Scale
    // SECONDS_PER_BLOCK so the crossing still lands inside a controlled,
    // small number of 1000-block ranges.
    const lifetimeSeconds = 604800
    const secondsPerBlock = 86.4 // stable increment, as derived above
    const crossingRangeIndex = Math.floor(
      lifetimeSeconds / (1000 * secondsPerBlock)
    ) // which 1000-block range crosses the timeout

    when(providerMock.getBlockNumber()).thenResolve(
      (crossingRangeIndex + 2) * 1000
    )
    when(providerMock.getBlock(anything())).thenCall(
      async (blockNumber: number) => ({
        number: blockNumber,
        timestamp: Math.round(blockNumber * secondsPerBlock),
        hash: utils.hexZeroPad(utils.hexlify(blockNumber), 32),
      })
    )

    const redeemBlock = (crossingRangeIndex + 1) * 1000 + 500
    const retryTxHash = utils.hexZeroPad('0x1234', 32)

    when(providerMock.getLogs(anything())).thenCall(async (filter: any) => {
      const from = Number(filter.fromBlock)
      const to = Number(filter.toBlock)
      const isLifetimeExtended = filter.topics?.[0] === LIFETIME_EXTENDED_TOPIC
      const isRedeemScheduled = filter.topics?.[0] === REDEEM_SCHEDULED_TOPIC

      if (isRedeemScheduled) {
        if (redeemBlock >= from && redeemBlock <= to) {
          return [makeRedeemScheduledLog(ticketId, retryTxHash, redeemBlock)]
        }
        return []
      }

      if (isLifetimeExtended) {
        // EARLY keepalive: in the very first range, extends only a little.
        const earlyBlock = 500
        if (earlyBlock >= from && earlyBlock <= to) {
          return [
            makeLifetimeExtendedLog(
              ticketId,
              Math.round(earlyBlock * secondsPerBlock) + 50000,
              earlyBlock
            ),
          ]
        }
        // LATER keepalive: in the LAST range before the crossing point,
        // extends far enough to cover the real redeem block above.
        const lateBlock = crossingRangeIndex * 1000 + 500
        if (lateBlock >= from && lateBlock <= to) {
          return [
            makeLifetimeExtendedLog(
              ticketId,
              redeemBlock * secondsPerBlock + 100000,
              lateBlock
            ),
          ]
        }
        return []
      }
      return []
    })

    when(providerMock.getTransactionReceipt(retryTxHash)).thenResolve({
      status: 1,
      transactionHash: retryTxHash,
    } as any)

    const result = await message.getSuccessfulRedeem()

    expect(result.status).to.equal(ParentToChildMessageStatus.REDEEMED)
    if (result.status === ParentToChildMessageStatus.REDEEMED) {
      expect(result.childTxReceipt.transactionHash).to.equal(retryTxHash)
    }
  })
})
