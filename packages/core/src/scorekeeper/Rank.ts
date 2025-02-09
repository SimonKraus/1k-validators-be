/**
 * Functions for Candidate rank and adding / docking points
 *
 * @function Rank
 */

import { logger, queries, Types } from "@1kv/common";
import { scorekeeperLabel } from "./scorekeeper";

export const dockPoints = async (stash: Types.Stash, bot): Promise<boolean> => {
  logger.info(`Stash ${stash} did BAD, docking points`, scorekeeperLabel);

  await queries.dockPoints(stash);

  const candidate = await queries.getCandidate(stash);
  bot?.sendMessage(
    `${candidate.name} docked points. New rank: ${candidate.rank}`,
  );

  return true;
};

/// Handles the adding of points to successful validators.
export const addPoint = async (stash: Types.Stash, bot): Promise<boolean> => {
  logger.info(`Stash ${stash} did GOOD, adding points`, scorekeeperLabel);

  await queries.addPoint(stash);

  const candidate = await queries.getCandidate(stash);
  bot?.sendMessage(
    `${candidate.name} did GOOD! Adding a point. New rank: ${candidate.rank}`,
  );

  return true;
};
