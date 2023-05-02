import "@keep-starknet-strange/madara-api-augment";

import { type ApiPromise } from "@polkadot/api";
import {
  type AddressOrPair,
  type ApiTypes,
  type SubmittableExtrinsic,
} from "@polkadot/api/types";
import { type GenericExtrinsic } from "@polkadot/types/extrinsic";
import {
  type DispatchError,
  type DispatchInfo,
  type Event,
  type EventRecord,
} from "@polkadot/types/interfaces";
import { type AnyTuple, type RegistryError } from "@polkadot/types/types";
import { u8aToHex } from "@polkadot/util";

import debugFactory from "debug";

const debug = debugFactory("test:substrateEvents");

export interface ExtrinsicCreation {
  extrinsic: GenericExtrinsic<AnyTuple>;
  events: EventRecord[];
  error: RegistryError;
  successful: boolean;
  hash: string;
}

// LAUNCH BASED NETWORK TESTING (PARA TESTS)

export async function waitOneBlock(
  api: ApiPromise,
  numberOfBlocks = 1
): Promise<void> {
  // eslint-disable-next-line no-async-promise-executor
  await new Promise<void>(async (res) => {
    let count = 0;
    const unsub = await api.derive.chain.subscribeNewHeads(async (header) => {
      console.log(
        `One block elapsed : #${header.number}: author : ${header.author}`
      );
      count += 1;
      if (count === 1 + numberOfBlocks) {
        unsub();
        res();
      }
    });
  });
}

// Log relay/parachain new blocks and events
export async function logEvents(api: ApiPromise, name: string) {
  api.derive.chain.subscribeNewHeads(async (header) => {
    debug(
      `------------- ${name} BLOCK#${header.number}: author ${header.author}, hash ${header.hash}`
    );
    const allRecords: EventRecord[] = (await (
      await api.at(header.hash)
    ).query.system // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .events()) as any;

    allRecords.forEach((e, i) => {
      debug(
        `${name} Event :`,
        i,
        header.hash.toHex(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e.toHuman() as any).event.section,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e.toHuman() as any).event.method
      );
    });
  });
}

async function lookForExtrinsicAndEvents(
  api: ApiPromise,
  extrinsicHash: Uint8Array
) {
  // We retrieve the block (including the extrinsics)
  const signedBlock = await api.rpc.chain.getBlock();

  // We retrieve the events for that block
  const allRecords: EventRecord[] = (await (
    await api.at(signedBlock.block.header.hash)
  ).query.system
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .events()) as any;

  const extrinsicIndex = signedBlock.block.extrinsics.findIndex((ext) => {
    return ext.hash.toHex() === u8aToHex(extrinsicHash);
  });
  if (extrinsicIndex < 0) {
    console.log(
      `Extrinsic ${extrinsicHash} is missing in the block ${signedBlock.block.header.hash}`
    );
  }
  const extrinsic = signedBlock.block.extrinsics[extrinsicIndex];

  // We retrieve the events associated with the extrinsic
  const events = allRecords
    .filter(
      ({ phase }) =>
        phase.isApplyExtrinsic &&
        phase.asApplyExtrinsic.toNumber() === extrinsicIndex
    )
    .map(({ event }) => event);
  return { events, extrinsic };
}

async function tryLookingForEvents(
  api: ApiPromise,
  extrinsicHash: Uint8Array
): Promise<ReturnType<typeof lookForExtrinsicAndEvents>> {
  await waitOneBlock(api);
  const { extrinsic, events } = await lookForExtrinsicAndEvents(
    api,
    extrinsicHash
  );
  if (events.length > 0) {
    return {
      extrinsic,
      events,
    };
  } else {
    return await tryLookingForEvents(api, extrinsicHash);
  }
}

export const createBlockWithExtrinsicParachain = async <
  Call extends SubmittableExtrinsic<ApiType>,
  ApiType extends ApiTypes
>(
  api: ApiPromise,
  sender: AddressOrPair,
  polkadotCall: Call
): Promise<{ extrinsic: GenericExtrinsic<AnyTuple>; events: Event[] }> => {
  console.log("-------------- EXTRINSIC CALL -------------------------------");
  // This should return a Uint8Array
  const extrinsicHash = (await polkadotCall.signAndSend(
    sender
  )) as unknown as Uint8Array;

  // We create the block which is containing the extrinsic
  // const blockResult = await context.createBlock();
  return await tryLookingForEvents(api, extrinsicHash);
};

export function filterAndApply<T>(
  events: EventRecord[],
  section: string,
  methods: string[],
  onFound: (record: EventRecord) => T
): T[] {
  return events
    .filter(
      ({ event }) => section === event.section && methods.includes(event.method)
    )
    .map((record) => onFound(record));
}

export function getDispatchError({
  event: {
    data: [dispatchError],
  },
}: EventRecord): DispatchError {
  return dispatchError as DispatchError;
}

function getDispatchInfo({
  event: { data, method },
}: EventRecord): DispatchInfo {
  return method === "ExtrinsicSuccess"
    ? (data[0] as DispatchInfo)
    : (data[1] as DispatchInfo);
}

export function extractError(
  events: EventRecord[] = []
): DispatchError | undefined {
  return filterAndApply(
    events,
    "system",
    ["ExtrinsicFailed"],
    getDispatchError
  )[0];
}

export function isExtrinsicSuccessful(events: EventRecord[] = []): boolean {
  return (
    filterAndApply(events, "system", ["ExtrinsicSuccess"], () => true).length >
    0
  );
}

export function extractInfo(
  events: EventRecord[] = []
): DispatchInfo | undefined {
  return filterAndApply(
    events,
    "system",
    ["ExtrinsicFailed", "ExtrinsicSuccess"],
    getDispatchInfo
  )[0];
}
