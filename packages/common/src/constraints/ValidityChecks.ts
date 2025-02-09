// Checks the online validity of a node
import {
  getLatestRelease,
  setBeefyKeysInvalidity,
  setBlockedInvalidity,
  setCommissionInvalidity,
  setConnectionTimeInvalidity,
  setIdentityInvalidity,
  setKusamaRankInvalidity,
  setLatestClientReleaseValidity,
  setOfflineAccumulatedInvalidity,
  setOnlineValidity,
  setProviderInvalidity,
  setSelfStakeInvalidity,
  setUnclaimedInvalidity,
  setValidateIntentionValidity,
} from "../db";
import { ChainData, Config, Constants, queries, Util } from "../index";
import axios from "axios";
import semver from "semver";
import logger from "../logger";
import { constraintsLabel } from "./constraints";

export const checkOnline = async (candidate: any) => {
  if (candidate && Number(candidate.onlineSince) === 0) {
    await setOnlineValidity(candidate.stash, false);
    return false;
  } else {
    await setOnlineValidity(candidate.stash, true);
    return true;
  }
};

// Check the validate intention for a single validator
export const checkValidateIntention = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
  candidate: any,
) => {
  const validators = await chaindata.getValidators();
  if (!validators.includes(Util.formatAddress(candidate?.stash, config))) {
    await setValidateIntentionValidity(candidate.stash, false);
    return false;
  } else {
    await setValidateIntentionValidity(candidate.stash, true);
    return true;
  }
};

// checks the validate intention for all validators
export const checkAllValidateIntentions = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
  candidates: any,
) => {
  const validators = await chaindata.getValidators();
  for (const candidate of candidates) {
    if (!validators.includes(Util.formatAddress(candidate.stash, config))) {
      await setValidateIntentionValidity(candidate.stash, false);
    } else {
      await setValidateIntentionValidity(candidate.stash, true);
    }
  }
};

// checks that the validator is on the latest client version
export const checkLatestClientVersion = async (
  config: Config.ConfigSchema,
  candidate: any,
) => {
  const skipClientUpgrade = config.constraints?.skipClientUpgrade || false;
  if (skipClientUpgrade!) {
    if (candidate?.implementation == "Kagome Node") {
      await setLatestClientReleaseValidity(candidate.stash, true);
      return true;
    }

    const forceLatestRelease = config.constraints.forceClientVersion;
    const latestRelease = await getLatestRelease();
    if (
      candidate.version &&
      latestRelease &&
      Date.now() > latestRelease.publishedAt + Constants.SIXTEEN_HOURS
    ) {
      const nodeVersion = semver.coerce(candidate.version);
      const latestVersion = forceLatestRelease
        ? semver.clean(forceLatestRelease)
        : semver.clean(latestRelease.name);

      const isUpgraded = semver.gte(nodeVersion, latestVersion);
      if (!isUpgraded) {
        await setLatestClientReleaseValidity(candidate.stash, false);
        return false;
      } else {
        await setLatestClientReleaseValidity(candidate.stash, true);
        return true;
      }
    } else {
      return false;
    }
  } else {
    await setLatestClientReleaseValidity(candidate.stash, true);
    return true;
  }
};

export const checkConnectionTime = async (
  config: Config.ConfigSchema,
  candidate: any,
) => {
  if (!config?.constraints?.skipConnectionTime) {
    const now = new Date().getTime();
    if (now - candidate.discoveredAt < Constants.WEEK) {
      await setConnectionTimeInvalidity(candidate.stash, false);
      return false;
    } else {
      await setConnectionTimeInvalidity(candidate.stash, true);
      return true;
    }
  } else {
    await setConnectionTimeInvalidity(candidate.stash, true);
    return true;
  }
};

export const checkIdentity = async (chaindata: ChainData, candidate: any) => {
  const [hasIdentity, verified] = await chaindata.hasIdentity(candidate.stash);
  if (!hasIdentity) {
    const invalidityString = `${candidate.name} does not have an identity set.`;
    await setIdentityInvalidity(candidate.stash, false, invalidityString);
    return false;
  }
  if (!verified) {
    const invalidityString = `${candidate.name} has an identity but is not verified by the registrar.`;
    await setIdentityInvalidity(candidate.stash, false, invalidityString);
    return false;
  }
  await setIdentityInvalidity(candidate.stash, true);
  return true;
};

export const checkOffline = async (candidate: any) => {
  const totalOffline = candidate.offlineAccumulated / Constants.WEEK;
  if (totalOffline > 0.02) {
    await setOfflineAccumulatedInvalidity(candidate.stash, false);
    return false;
  } else {
    await setOfflineAccumulatedInvalidity(candidate.stash, true);
    return true;
  }
};
export const checkCommission = async (
  chaindata: ChainData,
  targetCommission: number,
  candidate: any,
) => {
  const [commission, err] = await chaindata.getCommission(candidate.stash);
  if (err) {
    logger.warn(`{CheckComssion} there was an error: ${err}`);
    return false;
  }
  if (commission > targetCommission) {
    const invalidityString = `${
      candidate.name
    } commission is set higher than the maximum allowed. Set: ${
      commission / Math.pow(10, 7)
    }% Allowed: ${targetCommission / Math.pow(10, 7)}%`;
    await setCommissionInvalidity(candidate.stash, false, invalidityString);
    return false;
  } else {
    await setCommissionInvalidity(candidate.stash, true);
    return true;
  }
};

export const checkSelfStake = async (
  chaindata: ChainData,
  targetSelfStake: number,
  candidate: any,
) => {
  if (!candidate.skipSelfStake) {
    const [bondedAmt, err2] = await chaindata.getBondedAmount(candidate.stash);
    let invalidityString;
    if (err2) {
      invalidityString = `${candidate.name} ${err2}`;
      await setSelfStakeInvalidity(candidate.stash, false, invalidityString);
      return false;
    }
    if (parseInt(bondedAmt.toString()) < targetSelfStake) {
      invalidityString = `${
        candidate.name
      } has less than the minimum amount bonded: ${parseInt(
        bondedAmt.toString(),
      )} is bonded.`;
      await setSelfStakeInvalidity(candidate.stash, false, invalidityString);
      return false;
    }
  }
  await setSelfStakeInvalidity(candidate.stash, true);
  return true;
};

export const checkUnclaimed = async (
  chaindata: ChainData,
  unclaimedEraThreshold: number,
  candidate: any,
) => {
  const [currentEra, err3] = await chaindata.getActiveEraIndex();
  const threshold = currentEra - unclaimedEraThreshold - 1; // Validators cannot have unclaimed rewards before this era
  // If unclaimed eras contain an era below the recent threshold
  if (
    candidate.unclaimedEras &&
    !candidate.unclaimedEras.every((era) => era > threshold)
  ) {
    const invalidityString = `${candidate.name} has unclaimed eras: ${
      candidate.unclaimedEras
    } prior to era: ${threshold + 1}`;
    await setUnclaimedInvalidity(candidate.stash, false, invalidityString);
    return false;
  } else {
    await setUnclaimedInvalidity(candidate.stash, true);
    return true;
  }
};

// Checks if the validator blocks external nominations
export const checkBlocked = async (chaindata: ChainData, candidate: any) => {
  const isBlocked = await chaindata.getBlocked(candidate.stash);
  if (isBlocked) {
    const invalidityString = `${candidate.name} blocks external nominations`;
    await setBlockedInvalidity(candidate.stash, false, invalidityString);
    return false;
  } else {
    await setBlockedInvalidity(candidate.stash, true);
    return true;
  }
};

// Checks if the candidate has a banned infrastructure provider
export const checkProvider = async (
  config: Config.ConfigSchema,
  candidate: any,
) => {
  const location = await queries.getCandidateLocation(candidate.name);
  if (location && location.provider) {
    const bannedProviders = config.telemetry?.blacklistedProviders;
    if (bannedProviders?.includes(location.provider)) {
      logger.warn(
        `${candidate.name} has banned provider: ${location.provider}`,
        {
          label: "Constraints",
        },
      );
      await setProviderInvalidity(candidate.stash, false);
      return false;
    } else {
      await setProviderInvalidity(candidate.stash, true);
      return true;
    }
  } else {
    await setProviderInvalidity(candidate.stash, true);
    return true;
  }
};

export const checkKusamaRank = async (candidate: any) => {
  try {
    if (!candidate.skipSelfStake || !!candidate.kusamaStash) {
      const url = `${Constants.KOTVBackendEndpoint}/candidate/${candidate.kusamaStash}`;

      const res = await axios.get(url);

      if (!!res.data.invalidityReasons) {
        const invalidityReason = `${candidate.name} has a kusama node that is invalid: ${res.data.invalidityReasons}`;
        await setKusamaRankInvalidity(candidate.stash, false, invalidityReason);
        return false;
      }

      if (Number(res.data.rank) < 25) {
        const invalidityReason = `${candidate.name} has a Kusama stash with lower than 25 rank in the Kusama OTV programme: ${res.data.rank}.`;
        await setKusamaRankInvalidity(candidate.stash, false, invalidityReason);
        return false;
      }
    }
    await setKusamaRankInvalidity(candidate.stash, true);
    return true;
  } catch (e) {
    logger.warn(`Error trying to get kusama data...`);
  }
};

export const checkBeefyKeys = async (candidate: any) => {
  try {
    const isDummy = await queries.hasBeefyDummy(candidate.stash);
    if (isDummy) {
      const invalidityString = `${candidate.name} has not set beefy keys`;
      await setBeefyKeysInvalidity(candidate.stash, false, invalidityString);
      return false;
    } else {
      await setBeefyKeysInvalidity(candidate.stash, true);
      return true;
    }
  } catch (e) {
    logger.warn(`Error trying to get beefy keys...`, constraintsLabel);
  }
};
