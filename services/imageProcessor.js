const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

class ImageProcessor {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

async processImage(inputPath, outputPath, settings, index = 0) {
    try {
        // Load the base image
        const baseImage = sharp(inputPath);
        const metadata = await baseImage.metadata();

        // Start with the input image
        let image = sharp(inputPath);

        // Apply resize if needed
        if (settings.resize) {
            console.log('✅ Applying resize...');
            image = this.applyResize(image, settings.resize, metadata);
        }

        // Apply watermark if requested
        if (settings.watermark && settings.watermark.type !== 'none') {
            console.log('🧩 Applying watermark...');
            image = await this.applyWatermark(image, settings.watermark, metadata);
        }

        // Apply format settings
        image = this.applyFormat(image, settings);

        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Save to disk
        await image.toFile(outputPath);

        // Get final dimensions for verification
        const finalMetadata = await sharp(outputPath).metadata();
        console.log(`🎯 Final dimensions: ${finalMetadata.width}x${finalMetadata.height}`);

        const stats = fs.statSync(outputPath);
        return {
            success: true,
            originalSize: fs.statSync(inputPath).size,
            processedSize: stats.size,
            dimensions: {
                width: finalMetadata.width,
                height: finalMetadata.height
            }
        };

    } catch (error) {
        console.error(`❌ Error processing image ${inputPath}:`, error);
        throw new Error(`Failed to process image: ${error.message}`);
    }
}

applyResize(image, resizeSettings, metadata) {
    const { width, height, fit } = resizeSettings;
    
    console.log(`🔧 Resize settings: ${width}x${height}, fit: ${fit}`);
    console.log(`📏 Original dimensions: ${metadata.width}x${metadata.height}`);
    
    // Apply resize settings - allow enlargement for all fit types
    const resized = image.resize({
        width: width,
        height: height,
        fit: sharp.fit[fit] || sharp.fit.inside,
        withoutEnlargement: false // Allow enlargement
    });
    
    console.log(`✅ Resize applied: ${width}x${height} with fit '${fit}'`);
    return resized;
}

async applyWatermark(image, watermarkSettings, metadata) {
    const { type, text, font, position, opacity, imagePath, imageData } = watermarkSettings;

    console.log(`🔍 DEBUG: Full watermark settings:`, JSON.stringify(watermarkSettings, null, 2));
    console.log(`🔍 DEBUG: imagePath value:`, imagePath);
    console.log(`🔍 DEBUG: imageData length:`, imageData?.length || 0);
    console.log(`🔍 DEBUG: type value:`, type);

    console.log(`🧩 Applying watermark type: ${type}`);

    if (type === 'text' && text) {
        console.log(`📝 Text watermark: "${text}", font: ${font}, position: ${position}, opacity: ${opacity}`);
        return this.applyTextWatermark(image, { text, font, position, opacity }, metadata);
    } else if (type === 'image' && imageData) {
        console.log(`🖼️ Image watermark from base64, position: ${position}, opacity: ${opacity}`);
        return this.applyBase64Watermark(image, { imageData, position, opacity }, metadata);
    } else if (type === 'image' && imagePath) {
        console.log(`🖼️ Image watermark from file path: ${imagePath}, position: ${position}, opacity: ${opacity}`);
        return this.applyImageWatermark(image, { imagePath, position, opacity }, metadata);
    }

    console.log('⚠️ No valid watermark type found. Skipping...');
    return image;
}

async applyTextWatermark(image, settings, metadata) {
    const {
        text = 'Sample Watermark',
        font = 'Arial',
        fontSize = 24,
        fontStyle = 'bold',
        position = 'center',
        opacity = 0.5
    } = settings;

    // Get the actual dimensions of the resized image
    const imageBuffer = await image.toBuffer();
    const actualMetadata = await sharp(imageBuffer).metadata();

    const safeOpacity = isNaN(opacity) ? 0.5 : parseFloat(opacity);
    const baseFontSize = parseInt(fontSize) || 24;
    
    // Calculate responsive font size based on ACTUAL image dimensions
    const scaleFactor = Math.min(actualMetadata.width, actualMetadata.height) / 1000;
    const actualFontSize = Math.max(baseFontSize * scaleFactor, 5);
    
    // Better width estimation based on character count and font size
    const estimatedWidth = Math.min(actualMetadata.width * 1.5, text.length * actualFontSize * 1.2);
    const estimatedHeight = actualFontSize * 1.5;

    // Parse font style
    const isBold = fontStyle.includes('bold');
    const isItalic = fontStyle.includes('italic');
    const fontWeight = isBold ? 'bold' : 'normal';
    const fontStyleCSS = isItalic ? 'italic' : 'normal';

    const textSvg = Buffer.from(`
        <svg width="${estimatedWidth}" height="${estimatedHeight}">
            <style>
                .watermark {
                    font-family: "${font}", Arial, sans-serif;
                    font-size: ${actualFontSize}px;
                    font-weight: ${fontWeight};
                    font-style: ${fontStyleCSS};
                    fill: white;
                    fill-opacity: ${safeOpacity};
                    text-anchor: middle;
                    dominant-baseline: central;
                    stroke: rgba(0,0,0,0.3);
                    stroke-width: 0.5px;
                }
            </style>
            <text x="50%" y="50%" class="watermark">
                ${text.replace(/[<>&"']/g, (char) => {
                    const entities = {'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'};
                    return entities[char];
                })}
            </text>
        </svg>
    `);

    const gravity = this.getGravityFromPosition(position);

    try {
        console.log(`📝 Applying text watermark: "${text}" - Font: ${font} ${actualFontSize}px ${fontStyle}`);
        
        return sharp(imageBuffer).composite([{
            input: textSvg,
            gravity,
            blend: 'over'
        }]);
    } catch (err) {
        console.error('❌ Failed to apply text watermark:', err);
        throw err;
    }
}

async applyBase64Watermark(image, settings, metadata) {
    const {
        imageData,
        position = 'southeast',
        opacity = 0.7
    } = settings;

    if (!imageData) {
        console.warn('⚠️ No base64 watermark data provided');
        return image;
    }

    console.log('🖼️ Processing base64 watermark...');

    try {
        // Convert base64 to buffer
        const base64Data = imageData.replace(/^data:image\/[a-z]+;base64,/, '');
        const watermarkBuffer = Buffer.from(base64Data, 'base64');
        
        console.log(`📏 Base64 watermark buffer size: ${watermarkBuffer.length} bytes`);

        // Get main image as buffer and get real dimensions
        const baseBuffer = await image.toBuffer();
        const baseInfo = await sharp(baseBuffer).metadata();
        console.log(`📏 Base image: ${baseInfo.width}x${baseInfo.height}`);

        // Load watermark from buffer
        let watermark = sharp(watermarkBuffer);
        let watermarkInfo = await watermark.metadata();
        console.log(`💧 Watermark before resize: ${watermarkInfo.width}x${watermarkInfo.height}`);

        // Resize watermark if too large
        if (
            watermarkInfo.width > baseInfo.width ||
            watermarkInfo.height > baseInfo.height
        ) {
            const maxWidth = Math.floor(baseInfo.width * 0.3);
            const maxHeight = Math.floor(baseInfo.height * 0.3);

            console.log(`🔧 Resizing watermark to max ${maxWidth}x${maxHeight}...`);

            watermark = watermark.resize({
                width: maxWidth,
                height: maxHeight,
                fit: 'inside',
                withoutEnlargement: true
            });

            watermarkInfo = await watermark.metadata();
            console.log(`✅ Watermark after resize: ${watermarkInfo.width}x${watermarkInfo.height}`);
        } else {
            console.log('ℹ️ No resize needed for watermark');
        }

        const gravity = this.getGravityFromPosition(position);
        const watermarkOpacity = Math.max(0, Math.min(1, parseFloat(opacity)));

        // Get final watermark buffer
        const finalWatermarkBuffer = await watermark.png().toBuffer();

        const composited = sharp(baseBuffer).composite([
            {
                input: finalWatermarkBuffer,
                gravity,
                blend: 'over',
                opacity: watermarkOpacity
            }
        ]);

        console.log('✅ Base64 watermark composited successfully');
        return composited;

    } catch (error) {
        console.error('❌ Failed to apply base64 watermark:', error);
        throw error;
    }
}

async applyImageWatermark(image, settings, metadata) {
    const {
        imagePath,
        position = 'southeast',
        opacity = 0.5
    } = settings;

    if (!imagePath || !fs.existsSync(imagePath)) {
        console.warn('⚠️ Watermark image not found:', imagePath);
        return image;
    }

    console.log('🖼️ Loading watermark:', imagePath);

    // Get main image as buffer and get real dimensions
    const baseBuffer = await image.toBuffer();
    const baseInfo = await sharp(baseBuffer).metadata();
    console.log(`📏 Base image: ${baseInfo.width}x${baseInfo.height}`);

    // Load watermark
    let watermark = sharp(imagePath).png();
    let watermarkBuffer = await watermark.toBuffer();
    let watermarkInfo = await sharp(watermarkBuffer).metadata();
    console.log(`💧 Watermark before resize: ${watermarkInfo.width}x${watermarkInfo.height}`);

    // Resize watermark if too large
    if (
        watermarkInfo.width > baseInfo.width ||
        watermarkInfo.height > baseInfo.height
    ) {
        const maxWidth = Math.floor(baseInfo.width * 0.5);
        const maxHeight = Math.floor(baseInfo.height * 0.5);

        console.log(`🔧 Resizing watermark to max ${maxWidth}x${maxHeight}...`);

        watermarkBuffer = await sharp(watermarkBuffer)
            .resize({
                width: maxWidth,
                height: maxHeight,
                fit: 'inside',
                withoutEnlargement: true
            })
            .toBuffer();

        watermarkInfo = await sharp(watermarkBuffer).metadata();
        console.log(`✅ Watermark after resize: ${watermarkInfo.width}x${watermarkInfo.height}`);
    } else {
        console.log('ℹ️ No resize needed for watermark');
    }

    const gravity = this.getGravityFromPosition(position);

    try {
        const composited = sharp(baseBuffer).composite([
            {
                input: watermarkBuffer,
                gravity,
                blend: 'over',
                ...(opacity !== undefined ? { opacity: parseFloat(opacity) / 100 } : {})
            }
        ]);
        console.log('✅ Watermark composited successfully');
        return composited;
    } catch (compositeError) {
        console.error('❌ Composite failed:', compositeError);
        throw compositeError;
    }
}

getGravityFromPosition(position) {
    const gravityMap = {
        'center': 'center',
        'north': 'north',
        'northeast': 'northeast',
        'east': 'east',
        'southeast': 'southeast',
        'south': 'south',
        'southwest': 'southwest',
        'west': 'west',
        'northwest': 'northwest'
    };
    
    return gravityMap[position] || 'southeast';
}

applyFormat(image, settings) {
    const { format, quality } = settings;
    
    switch (format.toLowerCase()) {
        case 'webp':
            return image.webp({
                quality: quality,
                effort: 4,
                smartSubsample: true
            });
            
        case 'jpeg':
        case 'jpg':
            return image.jpeg({
                quality: quality,
                progressive: true,
                mozjpeg: true
            });
            
        case 'png':
            return image.png({
                compressionLevel: Math.round((100 - quality) / 10),
                progressive: true
            });
            
        case 'avif':
            return image.avif({
                quality: quality,
                effort: 4
            });
            
        case 'tiff':
            return image.tiff({
                quality: quality,
                compression: 'lzw'
            });
            
        default:
            return image.webp({ quality: quality });
    }
}

generateOutputFilename(originalName, settings, index) {
    const { naming, format } = settings;
    const extension = this.getFileExtension(format);
    
    switch (naming.type) {
        case 'original':
            const baseName = path.parse(originalName).name;
            return `${baseName}.${extension}`;
            
        case 'custom':
        case 'numbered':
            const number = (naming.start + index).toString().padStart(3, '0');
            return `${naming.prefix}${number}.${extension}`;
            
        default:
            return `${path.parse(originalName).name}.${extension}`;
    }
}

getFileExtension(format) {
    const extensionMap = {
        'webp': 'webp',
        'jpeg': 'jpg',
        'jpg': 'jpg',
        'png': 'png',
        'avif': 'avif',
        'tiff': 'tiff'
    };
    
    return extensionMap[format.toLowerCase()] || 'webp';
}

async batchProcess(files, settings, progressCallback) {
    const results = [];
    const total = files.length;
    const startTime = Date.now();
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const outputFilename = this.generateOutputFilename(file.originalname, settings, i);
        const outputPath = path.join(path.dirname(file.path), '..', 'processed', outputFilename);
        
        try {
            const result = await this.processImage(file.path, outputPath, settings, i);
            
            results.push({
                ...result,
                originalName: file.originalname,
                outputName: outputFilename,
                outputPath: outputPath
            });
            
            // Calculate progress and speed
            const processed = i + 1;
            const elapsed = (Date.now() - startTime) / 1000;
            const speed = processed / elapsed;
            const eta = (total - processed) / speed;
            
            // Call progress callback
            if (progressCallback) {
                progressCallback({
                    processed,
                    total,
                    progress: (processed / total) * 100,
                    speed,
                    eta: eta || 0,
                    status: 'processing'
                });
            }
            
        } catch (error) {
            results.push({
                success: false,
                error: error.message,
                originalName: file.originalname,
                outputName: outputFilename
            });
        }
    }
    
    return results;
}
}

module.exports = ImageProcessor;