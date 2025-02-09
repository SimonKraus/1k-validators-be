import { CronJob } from "cron";
import Nominator from "../../../nominator";
import {
  ApiHandler,
  ChainData,
  Config,
  Constants,
  Constraints,
  logger,
  queries,
  Util,
} from "@1kv/common";
import {
  activeValidatorJob,
  blockJob,
  eraPointsJob,
  eraStatsJob,
  inclusionJob,
  locationStatsJob,
  monitorJob,
  nominatorJob,
  scoreJob,
  sessionKeyJob,
  unclaimedEraJob,
  validatorPrefJob,
  validityJob,
} from "./WorkerJobs";
import { scorekeeperLabel } from "../../scorekeeper";
import { endRound, startRound } from "../../Round";

// Functions for starting the cron jobs

export const cronLabel = { label: "Cron" };

// Monitors the latest GitHub releases and ensures nodes have upgraded
// within a timely period.
export const startMonitorJob = async (config: Config.ConfigSchema) => {
  const monitorFrequency = config.cron?.monitor
    ? config.cron?.monitor
    : Constants.MONITOR_CRON;

  logger.info(
    `Starting Monitor Cron Job with frequency ${monitorFrequency}`,
    cronLabel,
  );

  const monitorCron = new CronJob(monitorFrequency, async () => {
    logger.info(
      `Monitoring the node version by polling latest Github releases.`,
      cronLabel,
    );
    await monitorJob();
  });

  monitorCron.start();
};

// Once a week reset the offline accumulations of nodes.
export const startClearAccumulatedOfflineTimeJob = async (
  config: Config.ConfigSchema,
) => {
  const clearFrequency = config.cron?.clearOffline
    ? config.cron?.clearOffline
    : Constants.CLEAR_OFFLINE_CRON;
  logger.info(
    `Starting Clear Accumulated Offline Time Job with frequency ${clearFrequency}`,
    cronLabel,
  );

  const clearCron = new CronJob(clearFrequency, () => {
    logger.info(`Running clear offline cron`, cronLabel);
    queries.clearAccumulated();
  });
  clearCron.start();
};

export const startValidatityJob = async (
  config: Config.ConfigSchema,
  constraints: Constraints.OTV,
) => {
  const enabled = config.cron?.validityEnabled || true;
  if (!enabled) {
    logger.warn(`Validity Job is disabled`, cronLabel);
    return;
  }
  const validityFrequency = config.cron?.validity
    ? config.cron?.validity
    : Constants.VALIDITY_CRON;
  logger.info(
    `Starting Validity Job with frequency ${validityFrequency}`,
    cronLabel,
  );

  let running = false;

  const validityCron = new CronJob(validityFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    const hasFinished = await validityJob(constraints);
    if (hasFinished) {
      running = false;
    }
  });
  validityCron.start();
};

// Runs job that updates scores of all validators
export const startScoreJob = async (
  config: Config.ConfigSchema,
  constraints: Constraints.OTV,
) => {
  const enabled = config.cron?.scoreEnabled || true;
  if (!enabled) {
    logger.warn(`Score Job is disabled`, cronLabel);
    return;
  }
  const scoreFrequency = config.cron?.score
    ? config.cron?.score
    : Constants.SCORE_CRON;
  logger.info(`Starting Score Job with frequency ${scoreFrequency}`, cronLabel);

  let running = false;

  const scoreCron = new CronJob(scoreFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    const hasFinished = await scoreJob(constraints);
    if (hasFinished) {
      running = false;
    }
  });
  scoreCron.start();
};

// Runs job that updates the era stats
export const startEraStatsJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.eraStatsEnabled || true;
  if (!enabled) {
    logger.warn(`Era Stats Job is disabled`, cronLabel);
    return;
  }
  const eraStatsFrequency = config.cron?.eraStats
    ? config.cron?.eraStats
    : Constants.ERA_STATS_CRON;
  logger.info(
    `Starting Era Stats Job with frequency ${eraStatsFrequency}`,
    cronLabel,
  );

  let running = false;

  const eraStatsCron = new CronJob(eraStatsFrequency, async () => {
    if (running) {
      return;
    }
    running = true;

    const hasFinished = await eraStatsJob(chaindata);
    if (hasFinished) {
      running = false;
    }
  });
  eraStatsCron.start();
};

// Executes any available time delay proxy txs if the current block
// is past the time delay proxy amount. This is a parameter `timeDelayBlocks` which can be
// specified in the config, otherwise defaults the constant of 10850 (~18 hours).
// Runs every 15 minutesB
export const startExecutionJob = async (
  handler: ApiHandler,
  nominatorGroups: Array<Nominator[]>,
  config: Config.ConfigSchema,
  bot: any,
) => {
  const timeDelayBlocks = config.proxy?.timeDelayBlocks
    ? Number(config.proxy?.timeDelayBlocks)
    : Number(Constants.TIME_DELAY_BLOCKS);
  const executionFrequency = config.cron?.execution
    ? config.cron?.execution
    : Constants.EXECUTION_CRON;
  logger.info(
    `Starting Execution Job with frequency ${executionFrequency} and time delay of ${timeDelayBlocks} blocks`,
    cronLabel,
  );

  const executionCron = new CronJob(executionFrequency, async () => {
    logger.info(`Running execution cron`, cronLabel);
    const api = await handler.getApi();
    const currentBlock = await api.rpc.chain.getBlock();
    const { number } = currentBlock.block.header;

    const chaindata = new ChainData(handler);

    const era = await chaindata.getCurrentEra();

    const allDelayed = await queries.getAllDelayedTxs();

    for (const data of allDelayed) {
      const { number: dataNum, controller, targets, callHash } = data;

      let validCommission = true;

      // find the nominator
      const nomGroup = nominatorGroups.find((nomGroup) => {
        return !!nomGroup.find((nom) => {
          return nom.bondedAddress == controller;
        });
      });
      const nominator = nomGroup.find((nom) => nom.bondedAddress == controller);
      const [bonded, err] = await chaindata.getBondedAmount(nominator.address);

      for (const target of targets) {
        const [commission, err] = await chaindata.getCommission(target);
        if (commission > config.constraints.commission) {
          validCommission = false;
          logger.warn(
            `${target} has invalid commission: ${commission}`,
            cronLabel,
          );
          if (bot) {
            await bot.sendMessage(
              `@room ${target} has invalid commission: ${commission}`,
            );
          }
        }
      }

      if (!validCommission) {
        const announcements = await chaindata.getProxyAnnouncements(
          nominator.address,
        );
        for (const announcement of announcements) {
          if (announcement.callHash == callHash) {
            logger.warn(`Cancelling call with hash: ${callHash}`, cronLabel);
            if (bot) {
              await bot.sendMessage(`Cancelling call with hash: ${callHash}`);
            }
            await nominator.cancelTx(announcement);
          }
        }
      }

      const shouldExecute =
        validCommission &&
        dataNum + Number(timeDelayBlocks) <= number.toNumber();

      if (shouldExecute) {
        logger.info(
          `tx first announced at block ${dataNum} is ready to execute. Executing....`,
          cronLabel,
        );

        // time to execute

        const innerTx = api.tx.staking.nominate(targets);
        const tx = api.tx.proxy.proxyAnnounced(
          nominator.address,
          controller,
          "Staking", // TODO: Add dynamic check for  proxy type - if the proxy type isn't a "Staking" proxy, the tx will fail
          innerTx,
        );

        const [didSend, finalizedBlockHash] = await nominator.sendStakingTx(
          tx,
          targets,
        );

        logger.info(
          `sent staking tx: ${didSend} finalizedBlockHash: ${finalizedBlockHash}`,
          cronLabel,
        );

        if (didSend) {
          // Create a Nomination Object
          await queries.setNomination(
            controller,
            era,
            targets,
            bonded,
            finalizedBlockHash,
          );

          // Log Execution
          const validatorsMessage = (
            await Promise.all(
              targets.map(async (n) => {
                const name = await queries.getCandidate(n);
                if (!name) {
                  logger.info(`did send: no entry for :${n}`, cronLabel);
                }
                if (name && !name.name) {
                  logger.info(`did send: no name for :${n}`, cronLabel);
                }
                if (n && name) {
                  return `- ${name.name} (${Util.addressUrl(n, config)})`;
                } else {
                  logger.info(
                    `did send: n: ${n} name: ${JSON.stringify(name)}`,
                    cronLabel,
                  );
                }
              }),
            )
          ).join("<br>");
          const validatorsHtml = (
            await Promise.all(
              targets.map(async (n) => {
                const name = await queries.getCandidate(n);
                if (name) {
                  return `- ${name.name} (${Util.addressUrl(n, config)})`;
                } else {
                  return `- ${JSON.stringify(
                    name,
                  )} (Invalid name!) (${Util.addressUrl(n, config)})`;
                }
              }),
            )
          ).join("<br>");
          const message = `${Util.addressUrl(
            nominator.address,
            config,
          )} executed announcement in finalized block #${finalizedBlockHash} annouced at #${dataNum} \n Validators Nominated:\n ${validatorsMessage}`;
          logger.info(message);
          if (bot) {
            await bot.sendMessage(
              `${Util.addressUrl(
                nominator.address,
                config,
              )} executed announcement in finalized block #${finalizedBlockHash} announced at block #${dataNum} <br> Validators Nominated:<br> ${validatorsHtml}`,
            );
          }

          await queries.deleteDelayedTx(dataNum, controller);
        }
        await Util.sleep(7000);
      }
    }
  });
  executionCron.start();
};

export const startCancelJob = async (
  config: Config.ConfigSchema,
  handler: ApiHandler,
  nominatorGroups: Array<Nominator[]>,
  chaindata: ChainData,
  bot: any,
) => {
  const cancelFrequency = config.cron?.cancel
    ? config.cron?.cancel
    : Constants.CANCEL_CRON;

  logger.info(
    `Running cancel cron with frequency: ${cancelFrequency}`,
    cronLabel,
  );

  const cancelCron = new CronJob(cancelFrequency, async () => {
    logger.info(`running cancel cron....`, cronLabel);

    const latestBlock = await chaindata.getLatestBlock();
    const threshold = latestBlock - 1.2 * config.proxy.timeDelayBlocks;

    for (const nomGroup of nominatorGroups) {
      for (const nom of nomGroup) {
        const isProxy = nom.isProxy;
        if (isProxy) {
          const announcements = await chaindata.getProxyAnnouncements(
            nom.address,
          );

          for (const announcement of announcements) {
            // If there are any specific announcements to cancel, try to cancel them,
            //     so long as they are registered on chain
            const blacklistedAnnouncements =
              config.proxy.blacklistedAnnouncements;
            if (blacklistedAnnouncements) {
              for (const blacklistedAnnouncement of blacklistedAnnouncements) {
                logger.info(
                  `there is a blacklisted announcement to cancel: ${blacklistedAnnouncement}`,
                  cronLabel,
                );
                if (bot) {
                  // await bot.sendMessage(
                  //   `{CancelCron::cancel} there is a blacklisted announcement to cancel: ${blacklistedAnnouncement}`
                  // );
                }

                // If the blacklisted announcement matches what's registered on chain, cancel it
                if (announcement.callHash == blacklistedAnnouncement) {
                  logger.info(
                    `cancelling ${announcement.callHash} - ${blacklistedAnnouncement}`,
                  );
                  const didCancel = await nom.cancelTx(announcement);
                  if (didCancel) {
                    const successfulCancelMessage = `{CancelCron::cancel} ${blacklistedAnnouncement} was successfully cancelled.`;
                    logger.info(successfulCancelMessage);
                    // await bot.sendMessage(successfulCancelMessage);
                  }
                } else {
                  logger.info(
                    `announcement call hash: ${announcement.callHash} does not match ${blacklistedAnnouncement}`,
                  );
                }
              }
            }

            // if it is too old, cancel it
            if (announcement.height < threshold) {
              await Util.sleep(10000);
              logger.info(
                `announcement at ${announcement.height} is older than threshold: ${threshold}. Cancelling...`,
                cronLabel,
              );
              const didCancel = await nom.cancelTx(announcement);
              if (didCancel) {
                logger.info(
                  `announcement from ${announcement.real} at ${announcement.height} was older than ${threshold} and has been cancelled`,
                  cronLabel,
                );
                if (bot) {
                  await bot.sendMessage(
                    `Proxy announcement from ${Util.addressUrl(
                      announcement.real,
                      config,
                    )} at #${
                      announcement.height
                    } was older than #${threshold} and has been cancelled`,
                  );
                }
              }
              await Util.sleep(10000);
            }
          }
        }
      }
    }
  });
  cancelCron.start();
};

export const startStaleNominationJob = async (
  config: Config.ConfigSchema,
  handler: ApiHandler,
  nominatorGroups: Array<Nominator[]>,
  chaindata: ChainData,
  bot: any,
) => {
  const staleFrequency = config.cron?.stale
    ? config.cron?.stale
    : Constants.STALE_CRON;

  logger.info(
    `Running stale nomination cron with frequency: ${staleFrequency}`,
    cronLabel,
  );
  const api = await handler.getApi();

  // threshold for a stale nomination - 8 eras for kusama, 2 eras for polkadot
  const threshold = config.global.networkPrefix == 2 ? 8 : 2;
  const staleCron = new CronJob(staleFrequency, async () => {
    logger.info(`running stale cron....`, cronLabel);

    const currentEra = await api.query.staking.currentEra();
    const allCandidates = await queries.allCandidates();

    for (const nomGroup of nominatorGroups) {
      for (const nom of nomGroup) {
        const stash = await nom.stash();
        if (!stash || stash == "0x") continue;
        const nominators = await api.query.staking.nominators(stash);
        if (!nominators.toJSON()) continue;

        const submittedIn = nominators.toJSON()["submittedIn"];
        const targets = nominators.toJSON()["targets"];

        for (const target of targets) {
          const isCandidate = allCandidates.filter(
            (candidate) => candidate.stash == target,
          );

          if (!isCandidate) {
            const message = `Nominator ${stash} is nominating ${target}, which is not a 1kv candidate`;
            logger.info(message);
            if (bot) {
              await bot.sendMessage(message);
            }
          }
        }

        if (submittedIn < Number(currentEra) - threshold) {
          const message = `Nominator ${stash} has a stale nomination. Last nomination was in era ${submittedIn} (it is now era ${currentEra})`;
          logger.info(message, cronLabel);
          if (bot) {
            await bot.sendMessage(message);
          }
        }
      }
    }
  });
  staleCron.start();
};

// Chain data querying cron jobs

// Chron job for writing era points
export const startEraPointsJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.eraPointsEnabled || true;
  if (!enabled) {
    logger.warn(`Era Points Job is disabled`, cronLabel);
    return;
  }
  const eraPointsFrequency = config.cron?.eraPoints
    ? config.cron?.eraPoints
    : Constants.ERA_POINTS_CRON;

  logger.info(
    `Running era points job with frequency: ${eraPointsFrequency}`,
    cronLabel,
  );

  let running = false;

  const eraPointsCron = new CronJob(eraPointsFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    logger.info(`running era points job....`, cronLabel);

    // Run the Era Points job
    const retries = 0;
    try {
      const hasFinished = await eraPointsJob(chaindata);
      if (hasFinished) {
        running = false;
      }
    } catch (e) {
      logger.warn(`There was an error running. retries: ${retries}`, cronLabel);
    }
  });
  eraPointsCron.start();
};

// Chron job for writing the active validators in the set
export const startActiveValidatorJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.activeValidatorEnabled || true;
  if (!enabled) {
    logger.warn(`Active Validator Job is disabled`, cronLabel);
    return;
  }
  const activeValidatorFrequency = config.cron?.activeValidator
    ? config?.cron?.activeValidator
    : Constants.ACTIVE_VALIDATOR_CRON;

  logger.info(
    `Running active validator job with frequency: ${activeValidatorFrequency}`,
    cronLabel,
  );

  let running = false;

  const activeValidatorCron = new CronJob(
    activeValidatorFrequency,
    async () => {
      if (running) {
        return;
      }
      running = true;
      logger.info(`running era points job....`, cronLabel);
      // Run the active validators job
      const hasFinished = await activeValidatorJob(chaindata);
      if (hasFinished) {
        running = false;
      }
    },
  );
  activeValidatorCron.start();
};

// Chron job for updating inclusion rates
export const startInclusionJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.inclusionEnabled || true;
  if (!enabled) {
    logger.warn(`Inclusion Job is disabled`, cronLabel);
    return;
  }
  const inclusionFrequency = config.cron?.inclusion
    ? config.cron?.inclusion
    : Constants.INCLUSION_CRON;

  logger.info(
    `Running inclusion job with frequency: ${inclusionFrequency}`,
    cronLabel,
  );

  let running = false;

  const inclusionCron = new CronJob(inclusionFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    logger.info(`running inclusion job....`, cronLabel);

    // Run the active validators job
    const hasFinished = await inclusionJob(chaindata);
    if (hasFinished) {
      running = false;
    }
  });
  inclusionCron.start();
};

// Chron job for updating session keys
export const startSessionKeyJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.sessionKeyEnabled || true;
  if (!enabled) {
    logger.warn(`Session Key Job is disabled`, cronLabel);
    return;
  }
  const sessionKeyFrequency = config.cron?.sessionKey
    ? config.cron?.sessionKey
    : Constants.SESSION_KEY_CRON;

  logger.info(
    `Running sesion key job with frequency: ${sessionKeyFrequency}`,
    cronLabel,
  );

  let running = false;

  const sessionKeyCron = new CronJob(sessionKeyFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    logger.info(`running session key job....`, cronLabel);

    // Run the active validators job
    const hasFinished = await sessionKeyJob(chaindata);
    if (hasFinished) {
      running = false;
    }
  });
  sessionKeyCron.start();
};

// Chron job for updating unclaimed eras
export const startUnclaimedEraJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const unclaimedErasFrequency = config?.cron?.unclaimedEras
    ? config?.cron?.unclaimedEras
    : Constants.UNCLAIMED_ERAS_CRON;

  logger.info(
    `(cron::UnclaimedEraJob::init) Running unclaimed era job with frequency: ${unclaimedErasFrequency}`,
  );

  let running = false;

  const unclaimedErasCron = new CronJob(unclaimedErasFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    logger.info(
      `{cron::UnclaimedEraJob::start} running unclaimed eras job....`,
    );

    const candidates = await queries.allCandidates();

    // Run the active validators job
    const unclaimedEraThreshold =
      config.global.networkPrefix == 2
        ? Constants.KUSAMA_FOUR_DAYS_ERAS
        : Constants.POLKADOT_FOUR_DAYS_ERAS;
    await unclaimedEraJob(chaindata);
    running = false;
  });
  unclaimedErasCron.start();
};

// Chron job for updating validator preferences
export const startValidatorPrefJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.validatorPrefEnabled || true;
  if (!enabled) {
    logger.warn(`Validator Pref Job is disabled`, cronLabel);
    return;
  }
  const validatorPrefFrequency = config.cron?.validatorPref
    ? config.cron?.validatorPref
    : Constants.VALIDATOR_PREF_CRON;

  logger.info(
    `Running validator pref cron with frequency: ${validatorPrefFrequency}`,
    cronLabel,
  );

  let running = false;

  const validatorPrefCron = new CronJob(validatorPrefFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    logger.info(`running validator pref job....`, cronLabel);

    // Run the active validators job
    const hasFinished = await validatorPrefJob(chaindata);
    if (hasFinished) {
      running = false;
    }
  });
  validatorPrefCron.start();
};

// Chron job for storing location stats of nodes
export const startLocationStatsJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.locationStatsEnabled || true;
  if (!enabled) {
    logger.warn(`Location Stats Job is disabled`, cronLabel);
    return;
  }
  const locationStatsFrequency = config.cron?.locationStats
    ? config.cron?.locationStats
    : Constants.LOCATION_STATS_CRON;

  logger.info(
    `Running location stats cron with frequency: ${locationStatsFrequency}`,
    cronLabel,
  );

  let running = false;

  const locationStatsCron = new CronJob(locationStatsFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    logger.info(`running location stats job....`, cronLabel);

    // Run the active validators job
    const hasFinished = await locationStatsJob(chaindata);
    if (hasFinished) {
      running = false;
    }
  });
  locationStatsCron.start();
};

// Chron job for querying nominator data
export const startNominatorJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.nominatorEnabled || true;
  if (!enabled) {
    logger.warn(`Nominator Job is disabled`, cronLabel);
    return;
  }
  const nominatorFrequency = config.cron?.nominator
    ? config.cron?.nominator
    : Constants.NOMINATOR_CRON;

  logger.info(
    `Running nominator cron with frequency: ${nominatorFrequency}`,
    cronLabel,
  );

  let running = false;

  const nominatorCron = new CronJob(nominatorFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    logger.info(`running nominator job....`, cronLabel);

    // Run the job
    const hasFinished = await nominatorJob(chaindata);
    if (hasFinished) {
      running = false;
    }
  });
  nominatorCron.start();
};

// Chron job for querying delegator data
export const startBlockDataJob = async (
  config: Config.ConfigSchema,
  chaindata: ChainData,
) => {
  const enabled = config.cron?.blockEnabled || true;
  if (!enabled) {
    logger.warn(`Block Job is disabled`, cronLabel);
    return;
  }
  const blockFrequency = config.cron?.block
    ? config.cron?.block
    : Constants.BLOCK_CRON;

  logger.info(
    `Running block cron with frequency: ${blockFrequency}`,
    cronLabel,
  );

  let running = false;

  const blockCron = new CronJob(blockFrequency, async () => {
    if (running) {
      return;
    }
    running = true;
    logger.info(`running block job....`, cronLabel);

    // Run the job
    const hasFinished = await blockJob(chaindata);
    if (hasFinished) {
      running = false;
    }
  });
  blockCron.start();
};

export const startMainScorekeeperJob = async (
  config,
  ending,
  chaindata,
  nominatorGroups,
  nominating,
  currentEra,
  bot,
  constraints,
  handler,
  currentTargets,
) => {
  // Main cron job for starting rounds and ending rounds of the scorekeeper
  const scoreKeeperFrequency = config.cron?.scorekeeper
    ? config.cron?.scorekeeper
    : Constants.SCOREKEEPER_CRON;

  const mainCron = new CronJob(scoreKeeperFrequency, async () => {
    logger.info(
      `Running mainCron of Scorekeeper with frequency ${scoreKeeperFrequency}`,
      scorekeeperLabel,
    );

    if (ending) {
      logger.info(`ROUND IS CURRENTLY ENDING.`, scorekeeperLabel);
      return;
    }

    const [activeEra, err] = await chaindata.getActiveEraIndex();
    if (err) {
      logger.warn(`CRITICAL: ${err}`, scorekeeperLabel);
      return;
    }

    const { lastNominatedEraIndex } = await queries.getLastNominatedEraIndex();

    // For Kusama, Nominations will happen every 4 eras
    // For Polkadot, Nominations will happen every era
    const eraBuffer = config.global.networkPrefix == 0 ? 1 : 4;

    const isNominationRound =
      Number(lastNominatedEraIndex) <= activeEra - eraBuffer;

    if (isNominationRound) {
      logger.info(
        `Last nomination was in era ${lastNominatedEraIndex}. Current era is ${activeEra}. This is a nomination round.`,
        scorekeeperLabel,
      );
      if (!nominatorGroups) {
        logger.info("No nominators spawned. Skipping round.", scorekeeperLabel);
        return;
      }

      if (!config.scorekeeper.nominating) {
        logger.info(
          "Nominating is disabled in the settings. Skipping round.",
          scorekeeperLabel,
        );
        return;
      }

      // Get all the current targets to check if this should just be a starting round or if the round needs ending
      const allCurrentTargets = [];
      for (const nomGroup of nominatorGroups) {
        for (const nominator of nomGroup) {
          // Get the current nominations of an address
          const currentTargets = await queries.getCurrentTargets(
            nominator.controller,
          );
          allCurrentTargets.push(currentTargets);
        }
      }
      currentTargets = allCurrentTargets;

      if (!currentTargets) {
        logger.info(
          "Current Targets is empty. Starting round.",
          scorekeeperLabel,
        );
        await startRound(
          nominating,
          currentEra,
          bot,
          constraints,
          nominatorGroups,
          chaindata,
          handler,
          config,
          currentTargets,
        );
      } else {
        logger.info(`Ending round.`, scorekeeperLabel);
        await endRound(
          ending,
          nominatorGroups,
          chaindata,
          constraints,
          bot,
          config,
        );
        await startRound(
          nominating,
          currentEra,
          bot,
          constraints,
          nominatorGroups,
          chaindata,
          handler,
          config,
          currentTargets,
        );
      }
    }
  });
  mainCron.start();
};
