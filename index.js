import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import sharp from "sharp";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage: storage });
const PORT = 8000;
const app = express();

const processedDir = "processed_files/";
const imagesDir = "compressed_images/";

// Ensure directories exist
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);

// Store processing status
const processingStatus = {};

// Function to check if the path is a URL or local file
const isUrl = (path) => /^https?:\/\//.test(path);

// Function to process local or remote images
const processImage = async (imagePath, outputPath) => {
  try {
    let imageBuffer;

    if (isUrl(imagePath)) {
      // Download the image if it's a URL
      const response = await axios({
        url: imagePath,
        responseType: "arraybuffer",
      });
      imageBuffer = response.data;
    } else {
      // Read the local file
      if (!fs.existsSync(imagePath)) throw new Error("File not found");
      imageBuffer = fs.readFileSync(imagePath);
    }

    // Compress the image
    await sharp(imageBuffer)
      .resize(500) // Resize width to 500px
      .jpeg({ quality: 60 }) // Compress to 60% quality
      .toFile(outputPath);

    return outputPath;
  } catch (error) {
    console.error(`❌ Error processing ${imagePath}: ${error.message}`);
    return "Error processing image";
  }
};

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded.");

  const requestId = uuidv4();
  processingStatus[requestId] = { status: "processing", filePath: null };

  const filePath = path.join("uploads", req.file.originalname);
  const results = [];
  const processingPromises = [];

  fs.createReadStream(filePath)
    .pipe(csvParser({ mapHeaders: ({ header }) => header.trim() }))
    .on("data", (row) => {
      if (!row["Input Image Urls"]) {
        console.error("❌ Missing column: Input Image Urls");
        return;
      }

      const inputImagePaths = row["Input Image Urls"]
        .replace(/"/g, "") // Remove quotes if present
        .split(",")
        .map((p) => p.trim());

      const imageProcessingTasks = inputImagePaths.map(
        async (imagePath, index) => {
          const ext = path.extname(imagePath) || ".jpg";
          const fileName = `compressed-${Date.now()}-${index}${ext}`;
          const outputPath = path.join(imagesDir, fileName);
          return processImage(imagePath, outputPath);
        }
      );

      processingPromises.push(
        Promise.all(imageProcessingTasks).then((outputImagePaths) => {
          results.push({
            "S.No.": row["S.No"],
            "Product Name": row["Product Name"],
            "Input Image Urls": `"${inputImagePaths.join(",")}"`,
            "Output Image Urls": `"${outputImagePaths.join(",")}"`,
          });
        })
      );
    })
    .on("end", async () => {
      await Promise.all(processingPromises);

      if (results.length === 0) {
        processingStatus[requestId].status = "error";
        return;
      }

      const updatedCsv = [
        Object.keys(results[0]).join(","), // Headers
        ...results.map((row) => Object.values(row).join(",")), // Data rows
      ].join("\n");

      const outputFilePath = path.join(
        processedDir,
        `processed-${req.file.originalname}`
      );
      fs.writeFileSync(outputFilePath, updatedCsv, "utf8");

      processingStatus[requestId] = {
        status: "completed",
        filePath: outputFilePath,
      };
    });

  res.json({
    message: "File uploaded successfully. Processing in progress.",
    requestId: requestId,
  });
});

// Check processing status
app.get("/status/:requestId", (req, res) => {
  const { requestId } = req.params;
  const statusInfo = processingStatus[requestId];

  if (!statusInfo) {
    return res.status(404).json({ error: "Invalid request ID" });
  }

  res.json({
    requestId,
    status: statusInfo.status,
    processedFile: statusInfo.filePath ? statusInfo.filePath : null,
  });
});

app.listen(PORT, () => {
  console.log(`${new Date().toISOString()} Server running on port ${PORT}`);
});
