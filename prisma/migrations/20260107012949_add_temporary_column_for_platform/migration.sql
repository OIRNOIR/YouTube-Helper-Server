/*
  Warnings:

  - The `platform` column on the `Video` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('YouTube', 'PeerTube');

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "platform_old" "Platform",
DROP COLUMN "platform",
ADD COLUMN     "platform" "Platform";
