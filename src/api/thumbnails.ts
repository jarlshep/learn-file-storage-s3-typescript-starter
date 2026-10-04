import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import type { ApiConfig } from "../config";
import { type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";

/* type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
}; */

/* const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
} */

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here

  const parsed = await req.formData();

  const thmnl = parsed.get("thumbnail");

  if (!(thmnl instanceof File)) {
    throw new BadRequestError("Not a valid thumbnail");
  }

  const MAX_UPLOAD_SIZE = 10 * (2**10) * (2**10);

  if (thmnl.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }

  const mimeType = thmnl.type;
  const mimeSplit = mimeType.split("/");
  const fileExt = mimeSplit[1];

  const allowedFileTypes: String[] = ["jpeg", "png"];
  if (!allowedFileTypes.includes(fileExt)) {
    throw new BadRequestError(`Invalid file type`);
  }

  const arrBuff: ArrayBuffer = await thmnl.arrayBuffer();

  const videoMetadata: Video | undefined = getVideo(cfg.db, videoId);

  if (!videoMetadata || userID !== videoMetadata.userID) {
    throw new UserForbiddenError("Video does not belong to user");
  }

  // new url to serve the image
  const fileName = `${randomBytes(32).toString("base64url")}.${fileExt}`;
  
  const assetPath = path.basename(cfg.assetsRoot);
  const diskPath = path.join(assetPath, fileName);
  const baseURL = `http://localhost:${cfg.port}`;
  
  const newURL = `${baseURL}/${diskPath}`;

  // put buffer into file
  Bun.write(diskPath, arrBuff);

  const videoUpdate = {
    id: videoMetadata.id,
    createdAt: new Date(videoMetadata.createdAt),
    updatedAt: new Date(videoMetadata.updatedAt),
    title: videoMetadata.title,
    description: videoMetadata.description,
    thumbnailURL: newURL,
    videoURL: undefined,
    userID: videoMetadata.userID,
  };

  updateVideo(cfg.db, videoUpdate);

  return respondWithJSON(200, videoUpdate);
}
