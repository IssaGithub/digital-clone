export type JobPayloadMap = {
  start_bot: { bookingId: string };
  draft_offer: { bookingId: string };
  render_reel: { reelId: string };
};

export type JobName = keyof JobPayloadMap;
