// Mocking the Nominator module with NominatorMock
// @ts-ignore
import Nominator from "../src/nominator";
import { ApiHandler, Types } from "@1kv/common";

jest.mock("../src/nominator", () => {
  const NominatorMock = jest.requireActual("./mock/nominator.mock").default; // Use jest.requireActual for relative imports
  return {
    __esModule: true, // This flag helps Jest understand it's mocking an ES6 module
    default: NominatorMock, // Mock the default export
  };
});
jest.mock("matrix-js-sdk", () => {
  // Return a mock implementation or object
  return {
    // Mock methods or objects you use from the SDK
  };
});

jest.mock("@1kv/common", () => {
  const actualCommon = jest.requireActual("@1kv/common");

  const ApiHandlerMock = require("./mock/apihandler.mock").default;
  return {
    ...actualCommon,
    ApiHandler: ApiHandlerMock,
  };
});

describe("Nominator Class Unit Tests", () => {
  let nominator: Nominator;
  let handler;
  let nominatorConfig: Types.NominatorConfig;

  // The corresponding address for the seed:
  const signerAddress = "DvDsrjvaJpXNW7XLvtFtEB3D9nnBKMqzvrijFffwpe7CCc6";
  beforeAll(async () => {
    handler = new ApiHandler(["Constants.KusamaEndpoints"]);
    await handler.setAPI();

    nominatorConfig = {
      isProxy: false,
      seed: "0x" + "00".repeat(32),
      proxyDelay: 10800,
      proxyFor: "0x" + "01".repeat(32),
    };

    nominator = new Nominator(handler, nominatorConfig, 2, null);
  });

  it("should match fields with config", async () => {
    // nominator.address
    expect(nominator.address).toEqual(signerAddress);

    // nominator.bondedAddress
    expect(nominator.bondedAddress).toEqual(signerAddress);

    // nominator.isProxy
    expect(nominator.isProxy).toEqual(false);

    // nominator.proxyDelay
    expect(nominator.proxyDelay).toEqual(10800);

    // nominator.stash
    expect(await nominator.stash()).toEqual(signerAddress);

    // nominator.payee
    expect(await nominator.payee()).toEqual(signerAddress);
  });

  it("should return true when calling nominate", async () => {
    // Act: Call the nominate function
    const result = await nominator.nominate(["target1", "target2"]);

    // Assert: Check that the result is true
    expect(result).toBe(true);
  });

  it("should update currentlyNominating when calling nominate", async () => {
    // Act: Call the nominate function
    await nominator.nominate(["target1", "target2"]);

    // Assert: Check that currentlyNominating was updated correctly
    expect(nominator.currentlyNominating).toEqual(["target1", "target2"]);
  });
});
