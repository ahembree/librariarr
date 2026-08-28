-- Transcode manager: optionally skip streams the media server reports as
-- hardware-accelerated (GPU encode), which cost the CPU little.
--
-- Off by default so existing transcode criteria keep matching exactly what
-- they matched before this column existed. Note that hardware acceleration
-- says nothing about whether the transcode is keeping *up* — a GPU can still
-- be saturated (transcode speed below 1x) — so this is a CPU-cost exemption,
-- not a health check.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "transcodeManagerExemptHardware" BOOLEAN NOT NULL DEFAULT false;
