-- The login rate limiter exempts an address a sign-in has succeeded from
-- from the floor shared by every unknown address (60 failures per 15 minutes
-- across all of them). That list lived in memory only, so after every restart
-- no address was known and an unauthenticated flood of about four wrong
-- passwords a minute refused every sign-in, the admin's included, for as long
-- as it lasted. The addresses are now kept here and loaded once per process.
--
-- No index beyond the primary key: the table holds at most a few thousand
-- rows, read whole once per process and written by primary key.
CREATE TABLE "KnownSignInAddress" (
    "address" TEXT NOT NULL,
    "lastSignInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnownSignInAddress_pkey" PRIMARY KEY ("address")
);
