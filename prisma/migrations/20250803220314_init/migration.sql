-- CreateEnum
CREATE TYPE "public"."Platform" AS ENUM ('YouTube');

-- CreateEnum
CREATE TYPE "public"."VideoType" AS ENUM ('video', 'short', 'stream');

-- CreateEnum
CREATE TYPE "public"."SponsorBlockStatus" AS ENUM ('sponsor', 'selfpromo', 'exclusive_access');

-- CreateTable
CREATE TABLE "public"."Video" (
    "videoId" TEXT NOT NULL,
    "platform" "public"."Platform" NOT NULL,
    "type" "public"."VideoType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "duration" BIGINT,
    "displayName" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "timestampMS" BIGINT NOT NULL,
    "isCurrentlyLive" BOOLEAN NOT NULL,
    "unread" BOOLEAN NOT NULL DEFAULT true,
    "sponsorBlockStatus" "public"."SponsorBlockStatus",

    CONSTRAINT "Video_pkey" PRIMARY KEY ("videoId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Video_videoId_key" ON "public"."Video"("videoId");
