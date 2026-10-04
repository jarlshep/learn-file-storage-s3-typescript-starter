import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { s3, S3Client, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import path from "node:path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const videoMetadata: Video | undefined = getVideo(cfg.db, videoId);

  if (!videoMetadata || userID !== videoMetadata.userID) {
    throw new UserForbiddenError("Video does not belong to user");
  }

  console.log("uploading video", videoId, "by user", userID);

  // implement the video upload here

  const parsed = await req.formData();

  const vid = parsed.get("video");

  if (!(vid instanceof File)) {
    throw new BadRequestError("Not a valid video");
  }

  const MAX_UPLOAD_SIZE = 10 * (2**10) * (2**10) * (2**10) ;

  if (vid.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }

  const mimeType = vid.type;
  const mimeSplit = mimeType.split("/");
  const fileExt = mimeSplit[1];

  const allowedFileTypes: String[] = ["mp4"];
  if (!allowedFileTypes.includes(fileExt)) {
    throw new BadRequestError(`Invalid file type`);
  }

  const arrBuff: ArrayBuffer = await vid.arrayBuffer();

  // temp file on disk
  const fileName = `${videoId}.${fileExt}`;
  
  const assetPath = path.basename(cfg.assetsRoot);
  const pathOnDisk = path.join(assetPath, fileName);

  // put buffer into temp file
  await Bun.write(pathOnDisk, arrBuff); // await!!
  const fileToProcess = Bun.file(pathOnDisk);

  const aspectRatioPrefix = await getVideoAspectRatio(pathOnDisk);

  const pathToProcessed = await processVideoForFastStart(pathOnDisk);

  const fileToS3 = Bun.file(pathToProcessed);

  // send file to S3
  try {
    await s3.write(`${aspectRatioPrefix}/${fileName}`, fileToS3, {
      type: "video/mp4",
    });
    await Bun.file(pathToProcessed).delete();
    await fileToProcess.delete();
  } catch (error) {
    console.error("Upload failed:", error);
    throw error;
  }

  const newVideoURL = `${aspectRatioPrefix}/${fileName}`;
  // const newVideoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${aspectRatioPrefix}/${fileName}`;

  const videoUpdate = {
    id: videoMetadata.id,
    createdAt: new Date(videoMetadata.createdAt),
    updatedAt: new Date(videoMetadata.updatedAt),
    title: videoMetadata.title,
    description: videoMetadata.description,
    thumbnailURL: videoMetadata.thumbnailURL,
    videoURL: newVideoURL,
    userID: videoMetadata.userID,
  };

  const vidReturn = await dbVideoToSignedVideo(cfg, videoUpdate);

  updateVideo(cfg.db, videoUpdate);

  return respondWithJSON(200, vidReturn);
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath]);
  await proc.exited;
  const stdoutText = await new Response(proc.stdout).text();
  // const stderrText = await new Response(proc.stderr).text();

  const stdoutJSON = JSON.parse(stdoutText);
  
  const width = Math.floor(Number(stdoutJSON.streams[0].width));
  const height = Math.floor(Number(stdoutJSON.streams[0].height));

  const aspectRatioDiv = width/height;
  let aspectRatio = "";

  if (aspectRatioDiv <= 0.9) {
    aspectRatio = "portrait";
  } else if (aspectRatioDiv >= 1.1) {
    aspectRatio = "landscape";
  } else {
    aspectRatio = "other";
  }

  return aspectRatio;
}

export async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const split = path.basename(inputFilePath).split(".");
  const processedFilePath = `${path.dirname(inputFilePath)}/${split[0]}.processed${path.extname(inputFilePath)}`;
  // console.log(`processedFilePath: ${processedFilePath}`);

  try {
    const proc = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", processedFilePath]);
    await proc.exited;
    const stderrText = await new Response(proc.stderr).text();
    // console.log(`stderrText within faststart process: ${stderrText}`);

  } catch (error) {
    throw new Error("Processing video for fast start failed");
  }
  
  return processedFilePath;
}

export async function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  return cfg.s3Client.presign(key, {
    expiresIn: expireTime,
  });
}

export async function dbVideoToSignedVideo(cfg: ApiConfig, video: Video): Promise<Video> {

  let key = "";
  if (!video.videoURL) {
    // throw new Error("No video URL for key to presign");
    return video;
  } else {
    key = video.videoURL;
  }

  const presignedURL = await generatePresignedURL(cfg, key, 300);

  const videoUpdate = {
    id: video.id,
    createdAt: new Date(video.createdAt),
    updatedAt: new Date(video.updatedAt),
    title: video.title,
    description: video.description,
    thumbnailURL: video.thumbnailURL,
    videoURL: presignedURL,
    userID: video.userID,
  };

  console.log(videoUpdate);

  return videoUpdate;
}