-- Optional ceiling on how many items one destructive run may act on.
--
-- NULL means no ceiling, which is both the default and the previous behaviour:
-- automated deletion without a limit is the point of the application, and a
-- user whose rules legitimately select thousands of items should not have to
-- confirm it every time. Opt in by setting a number.
ALTER TABLE "AppSettings" ADD COLUMN "maxAutoDeleteItems" INTEGER;
