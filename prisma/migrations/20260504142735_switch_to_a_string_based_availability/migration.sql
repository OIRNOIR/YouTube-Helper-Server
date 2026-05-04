/*
  Warnings:

  - You are about to drop the column `isAvailable` on the `Video` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "VideoAvailability" AS ENUM ('private', 'premium_only', 'subscriber_only', 'needs_auth', 'unlisted', 'public');

-- AlterTable
ALTER TABLE "Video" DROP COLUMN "isAvailable",
ADD COLUMN     "availability" "VideoAvailability" NOT NULL DEFAULT 'public';
