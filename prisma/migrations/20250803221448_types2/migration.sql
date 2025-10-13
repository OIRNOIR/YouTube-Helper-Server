/*
  Warnings:

  - You are about to alter the column `duration` on the `Video` table. The data in that column could be lost. The data in that column will be cast from `BigInt` to `Integer`.
  - Changed the type of `timestampMS` on the `Video` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "public"."Video" ALTER COLUMN "duration" SET DATA TYPE INTEGER,
DROP COLUMN "timestampMS",
ADD COLUMN     "timestampMS" TIMESTAMP(3) NOT NULL;
