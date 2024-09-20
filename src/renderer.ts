
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';


//----------------------------------------------------------------------------------------------------------------------

import * as puppeteer from 'puppeteer';
import * as url from 'url';

import {Config} from './config';

type SerializedResponse = {
  status: number; content: string;
};

type ViewportDimensions = {
  width: number; height: number;
};

const MOBILE_USERAGENT =
    'Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.75 Mobile Safari/537.36';

/**
 * Wraps Puppeteer's interface to Headless Chrome to expose high level rendering
 * APIs that are able to handle web components and PWAs.
 */
export class Renderer {
  private browser: puppeteer.Browser;
  private config: Config;

  constructor(browser: puppeteer.Browser, config: Config) {
    this.browser = browser;
    this.config = config;
  }

  async serialize(requestUrl: string, isMobile: boolean):
      Promise<SerializedResponse> {
    /**
     * Executed on the page after the page has loaded. Strips script and
     * import tags to prevent further loading of resources.
     */
    function stripPage() {
      // Strip only script tags that contain JavaScript (either no type attribute or one that contains "javascript")
      const elements = document.querySelectorAll('script:not([type]), script[type*="javascript"], link[rel=import]');
      for (const e of Array.from(elements)) {
        e.remove();
      }
    }

    /**
     * Injects a <base> tag which allows other resources to load. This
     * has no effect on serialised output, but allows it to verify render
     * quality.
     */
    function injectBaseHref(origin: string) {
      const base = document.createElement('base');
      base.setAttribute('href', origin);

      const bases = document.head.querySelectorAll('base');
      if (bases.length) {
        // Patch existing <base> if it is relative.
        const existingBase = bases[0].getAttribute('href') || '';
        if (existingBase.startsWith('/')) {
          bases[0].setAttribute('href', origin + existingBase);
        }
      } else {
        // Only inject <base> if it doesn't already exist.
        document.head.insertAdjacentElement('afterbegin', base);
      }
    }

    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport({width: this.config.width, height: this.config.height, isMobile});

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    page.evaluateOnNewDocument('customElements.forcePolyfill = true');
    page.evaluateOnNewDocument('ShadyDOM = {force: true}');
    page.evaluateOnNewDocument('ShadyCSS = {shimcssproperties: true}');

    let response: puppeteer.Response|null = null;
    // Capture main frame response. This is used in the case that rendering
    // times out, which results in puppeteer throwing an error. This allows us
    // to return a partial response for what was able to be rendered in that
    // time frame.
    page.addListener('response', (r: puppeteer.Response) => {
      if (!response) {
        response = r;
      }
    });

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response = await page.goto(
          requestUrl, {timeout: this.config.timeout, waitUntil: 'networkidle0'});
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      console.error('response does not exist');
      // This should only occur when the page is about:blank. See
      // https://github.com/GoogleChrome/puppeteer/blob/v1.5.0/docs/api.md#pagegotourl-options.
      await page.close();
      return {status: 400, content: ''};
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      return {status: 403, content: ''};
    }

    // Set status to the initial server's response code. Check for a <meta
    // name="render:status_code" content="4xx" /> tag which overrides the status
    // code.
    let statusCode = response.status();
    const newStatusCode =
        await page
            .$eval(
                'meta[name="render:status_code"]',
                (element) => parseInt(element.getAttribute('content') || ''))
            .catch(() => undefined);
    // On a repeat visit to the same origin, browser cache is enabled, so we may
    // encounter a 304 Not Modified. Instead we'll treat this as a 200 OK.
    if (statusCode === 304) {
      statusCode = 200;
    }
    // Original status codes which aren't 200 always return with that status
    // code, regardless of meta tags.
    if (statusCode === 200 && newStatusCode) {
      statusCode = newStatusCode;
    }

    // Remove script & import tags.
    await page.evaluate(stripPage);
    // Inject <base> tag with the origin of the request (ie. no path).
    const parsedUrl = url.parse(requestUrl);
    await page.evaluate(
        injectBaseHref, `${parsedUrl.protocol}//${parsedUrl.host}`);

    // Serialize page.
    const result = await page.evaluate('document.firstElementChild.outerHTML');

    await page.close();
    return {status: statusCode, content: result};
  }

  async screenshot(
      url: string,
      isMobile: boolean,
      dimensions: ViewportDimensions,
      options?: object): Promise<Buffer> {
    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport(
        {width: dimensions.width, height: dimensions.height, isMobile});

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    let response: puppeteer.Response|null = null;

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response =
          await page.goto(url, {timeout: 10000, waitUntil: 'networkidle0'});
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      throw new ScreenshotError('NoResponse');
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response!.headers()['metadata-flavor'] === 'Google') {
      throw new ScreenshotError('Forbidden');
    }

    // Must be jpeg & binary format.
    const screenshotOptions = Object.assign({}, options, {type: 'jpeg', encoding: 'binary'});
    // Screenshot returns a buffer based on specified encoding above.
    // https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#pagescreenshotoptions
    const buffer = await page.screenshot(screenshotOptions) as Buffer;
     

//----------------------------------------------------Copy JPG to the S3 Bucket----------------------------------------------------



// Interface to handle input parameters
interface S3UploadParams {
  bucketName: string;
  region: string;
  key: string; // S3 key (file path + file name)
  buffer: Buffer; // The image buffer to be uploaded
  contentType: string; // Content-Type of the image (e.g., image/jpeg)
  accessKeyId: string; // Your AWS Access Key
  secretAccessKey: string; // Your AWS Secret Key
}

// Function to create an AWS Signature v4
const createSignature = (
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
  stringToSign: string
) => {
  const kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  return crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
};

// Function to upload image buffer to S3 without AWS SDK
const uploadImageToS3WithoutSDK = async ({
  bucketName,
  region,
  key,
  buffer,
  contentType,
  accessKeyId,
  secretAccessKey,
}: S3UploadParams): Promise<void> => {
  const host = `${bucketName}.s3.${region}.amazonaws.com`;
  const method = 'PUT';
  const service = 's3';
  const amzDate = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const date = amzDate.substr(0, 8);

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const canonicalUri = `/${key}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  // Generate the canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD', // Since this is a PUT request with binary payload
  ].join('\n');

  // Generate the string to sign
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  // Create the signature
  const signature = createSignature(secretAccessKey, date, region, service, stringToSign);

  // Create the Authorization header
  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Create the HTTPS request options
  const options = {
    hostname: host,
    port: 443,
    path: `/${key}`,
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      Authorization: authorizationHeader,
      'Content-Length': buffer.length,
    },
  };

  // Send the request using the HTTPS module
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode === 200) {
        console.log(`File uploaded successfully: ${key}`);
        resolve();
      } else {
        reject(new Error(`Failed to upload. Status Code: ${res.statusCode}`));
      }
    });

    req.on('error', (e) => {
      reject(e);
    });

    // Write the image buffer as the body of the request
    req.write(buffer);
    req.end();
  });
};

// Usage example
(async () => {
  try {
    // Load an image from file system for demonstration purposes
    //const filePath = path.resolve(__dirname, 'image.jpg');
    //const imageBuffer = fs.readFileSync(filePath); // Replace with your actual buffer
    const imageBuffer = buffer

    
    // AWS S3 bucket parameters
    const bucketName = 'radarimagesbucket';
    const region = 'us-east-2'; // e.g., 'us-west-1'
    const key = 'images/my-uploaded-image.jpg';
    const contentType = 'image/jpeg'; // Adjust for your image type
    const accessKeyId = S3_ACCESSKEY;
    const secretAccessKey = s3_SECRETACCESSKEY;

    // Call the function to upload the image buffer
    await uploadImageToS3WithoutSDK({
      bucketName,
      region,
      key,
      buffer: imageBuffer,
      contentType,
      accessKeyId,
      secretAccessKey,
    });
    console.log('Image uploaded successfully.');
  } catch (error) {
    console.error('Error uploading image:', error);
  }
})();
 


    

//-------------------------------------------------------------------------------------------------------------------------------


    return buffer;
    
  }
}

type ErrorType = 'Forbidden'|'NoResponse';

export class ScreenshotError extends Error {
  type: ErrorType;

  constructor(type: ErrorType) {
    super(type);

    this.name = this.constructor.name;

    this.type = type;
  }
}
