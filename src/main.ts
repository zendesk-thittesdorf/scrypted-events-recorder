import sdk, { HttpRequest, HttpRequestHandler, HttpResponse, Image, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, ScryptedNativeId, Setting, SettingValue, Settings, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { EventsRecorderMixin } from './eventsRecorderMixin';
import fs from 'fs';
import path from 'path';
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import moment from 'moment';

// Overlays a small delete button on every RECORDED CLIPS thumbnail in
// Scrypted core's own UI, reading deviceId/filename straight out of the
// thumbnail's own <img src> (it's built by getVideoclipWebhookUrls() and
// already contains both). Served as a static file via the `clipDeleteOverlay.js`
// webhook below, and injected into core's index.html by
// ensureClipDeleteOverlayInjected() so no browser extension is needed.
const CLIP_DELETE_OVERLAY_JS = `(function () {
  const THUMB_MARKER = 'videoclipThumbnail?';
  const DELETE_MARKER = 'deleteVideoclip?';

  function position(btn, img) {
    btn.style.top = (img.offsetTop + 2) + 'px';
    btn.style.left = (img.offsetLeft + img.offsetWidth - 24) + 'px';
  }

  function decorate(img) {
    if (img.dataset.deleteBtnAdded) return;
    img.dataset.deleteBtnAdded = '1';

    const parent = img.parentElement;
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    const btn = document.createElement('button');
    btn.textContent = '\\u{1F5D1}';
    btn.title = 'Delete this recorded clip';
    btn.style.cssText = [
      'position:absolute', 'z-index:9999',
      'background:rgba(0,0,0,.65)', 'color:#fff', 'border:none',
      'border-radius:4px', 'width:22px', 'height:22px', 'cursor:pointer',
      'font-size:13px', 'line-height:1', 'padding:0',
    ].join(';');
    position(btn, img);

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm('Delete this recorded clip permanently?')) return;

      btn.disabled = true;
      btn.textContent = '\\u2026';
      try {
        const url = img.src.replace(THUMB_MARKER, DELETE_MARKER);
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status + ' ' + await res.text());
        parent.remove();
      } catch (err) {
        alert('Failed to delete clip: ' + err.message);
        btn.disabled = false;
        btn.textContent = '\\u{1F5D1}';
      }
    });

    parent.appendChild(btn);
  }

  function scan() {
    document.querySelectorAll('img[src*="' + THUMB_MARKER + '"]').forEach(decorate);
  }

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
`;

interface MixinStorage {
  total: number;
  occupied: number;
  free: number;
}

export class EventsRecorderPlugin extends BasePlugin implements Settings, HttpRequestHandler {
  currentMixins = new Set<EventsRecorderMixin>();
  mixinStorage: Record<string, MixinStorage> = {};

  storageSettings = new StorageSettings(this, {
    ...getBaseSettings({
      onPluginSwitch: (_, enabled) => this.startStop(enabled),
      hideHa: true,
      hideMqtt: true,
    }),
    storagePath: {
      title: 'Storage path',
      description: 'Disk path where to save the clips',
      type: 'string',
      onPut: async () => await this.start()
    },
    occupiedSpaceInGb: {
      title: 'Memory allocated',
      type: 'number',
      range: [0, 250],
      readonly: true,
      placeholder: 'GB'
    },
  });

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId, {
      pluginFriendlyName: 'Events recorder'
    });

    this.start().then().catch(this.getLogger().log);
  }

  getLogger() {
    return super.getLoggerInternal({});
  }

  async startStop(enabled: boolean) {
    if (enabled) {
      await this.start();
    } else {
      await this.stop();
    }
  }

  async stop() {
    await this.mqttClient?.disconnect();
  }

  async start() {
    const { storagePath } = this.storageSettings.values;

    if (storagePath) {
      try {
        await fs.promises.access(storagePath);
      } catch {
        await fs.promises.mkdir(storagePath, { recursive: true });
      }
    } else {
      this.getLogger().error('Storage path not defined');
    }

    process.on('exit', this.cleanAllListeners);
    process.on('SIGINT', this.cleanAllListeners);
    process.on('SIGTERM', this.cleanAllListeners);
    process.on('uncaughtException', this.cleanAllListeners);

    await this.ensureClipDeleteOverlayInjected();
  }

  // Injects <script src=".../clipDeleteOverlay.js"> into Scrypted core's own
  // index.html, so the "delete clip" button on RECORDED CLIPS thumbnails
  // works out of the box with no browser extension. Idempotent (checks a
  // marker comment first) and re-run on every plugin start, so it self-heals
  // if a core update ever overwrites index.html.
  async ensureClipDeleteOverlayInjected() {
    const logger = this.getLogger();
    const marker = '<!-- events-recorder:clip-delete-overlay -->';

    try {
      // This plugin's bundle lives at .../plugins/@apocaliss92/scrypted-events-recorder/zip/unzipped,
      // and core is a sibling under .../plugins/@scrypted/core. Derive the
      // shared "plugins" root from our own __dirname rather than hardcoding
      // an absolute path, since it can vary by install (docker volume, etc).
      const pluginsRootMatch = __dirname.match(/^(.*[\\/]plugins)[\\/]/);
      if (!pluginsRootMatch) {
        logger.debug(`Could not determine plugins root from ${__dirname}, skipping core UI overlay injection`);
        return;
      }

      const indexHtmlPath = path.join(pluginsRootMatch[1], '@scrypted', 'core', 'zip', 'unzipped', 'fs', 'dist', 'index.html');

      let html: string;
      try {
        html = await fs.promises.readFile(indexHtmlPath, 'utf8');
      } catch {
        logger.debug(`Core index.html not found at ${indexHtmlPath}, skipping overlay injection`);
        return;
      }

      if (html.includes(marker)) {
        return;
      }

      if (!html.includes('</body>')) {
        logger.debug('Core index.html has no </body>, skipping overlay injection');
        return;
      }

      const scriptBase = await sdk.endpointManager.getPath(undefined, { public: true });
      const scriptUrl = `${scriptBase}clipDeleteOverlay.js`;
      const injected = html.replace('</body>', `${marker}\n<script defer src="${scriptUrl}"></script>\n</body>`);

      await fs.promises.writeFile(indexHtmlPath, injected);
      logger.log(`Injected clip-delete overlay script into core UI (${indexHtmlPath})`);
    } catch (e) {
      logger.log('Failed to inject clip-delete overlay into core UI', e);
    }
  }

  cleanAllListeners() {
    this.currentMixins.forEach(mixin => mixin.resetListeners());
  }

  setMixinOccupancy(deviceId: string, data: MixinStorage) {
    this.mixinStorage[deviceId] = data;
    const totalData: MixinStorage = {
      free: 0,
      occupied: 0,
      total: 0
    };

    Object.values(this.mixinStorage).forEach(data => {
      totalData.free += data.free;
      totalData.occupied += data.occupied;
      totalData.total += data.total;
    });

    this.putSetting('occupiedSpaceInGb', totalData.occupied.toFixed(2));
    this.storageSettings.settings.occupiedSpaceInGb.range = [0, Number(totalData.total.toFixed(2))];
  }


  async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
    const url = new URL(`http://localhost${request.url}`);
    const params = url.searchParams.get('params') ?? '{}';
    const logger = this.getLogger();

    try {
      const [_, __, ___, ____, privateWebhook, ...rest] = url.pathname.split('/');

      try {
        // Static, device-agnostic script served straight from the plugin so
        // the "delete clip" overlay button works without any browser
        // extension - see ensureClipDeleteOverlayInjected(), which injects a
        // <script src="this URL"> into Scrypted core's own index.html.
        if (privateWebhook === 'public' && rest[0] === 'clipDeleteOverlay.js') {
          response.send(CLIP_DELETE_OVERLAY_JS, {
            headers: {
              'Content-Type': 'application/javascript',
            }
          });
          return;
        }

        // Since no API is available, needs to mimic NVR
        if (privateWebhook === 'thumbnail') {
          const [deviceId, filename] = rest;
          const dev: EventsRecorderMixin = this.currentMixins[deviceId];
          const devConsole = dev.getLogger();
          const height = url.searchParams.get('height');
          devConsole.debug(`Thumbnail requested: ${JSON.stringify({
            filename,
            deviceId,
            height,
          })}`);
          const eventTimestamp = Number(filename.split('.')[0]);
          const { eventImagePath } = dev.getStorageDirs({ eventTimestamp });

          let jpeg = await fs.promises.readFile(eventImagePath);

          if (height) {
            const mo = await sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
            const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(mo, ScryptedMimeTypes.Image);
            const resizedImage = await convertedImage.toImage({
              resize: {
                height: Number(height),
              },
            });
            jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(resizedImage, 'image/jpeg');
          }

          response.send(jpeg, {
            headers: {
              'Content-Type': 'image/jpeg',
            }
          });
          return;
        } else {
          const [webhook] = rest;
          const { deviceId, filename, parameters } = JSON.parse(params);
          const dev: EventsRecorderMixin = this.currentMixins[deviceId];
          const devConsole = dev.getLogger();
          devConsole.debug(`Request with parameters: ${JSON.stringify({
            webhook,
            deviceId,
            filename,
            parameters
          })}`);

          if (webhook === 'videoclip') {
            const { videoClipPath } = dev.getStorageDirs({ videoClipNameSrc: filename });
            const stat = await fs.promises.stat(videoClipPath);
            const fileSize = stat.size;
            const range = request.headers.range;

            devConsole.debug(`Videoclip requested: ${JSON.stringify({
              videoClipPath,
              filename,
              deviceId,
            })}`);

            if (range) {
              const parts = range.replace(/bytes=/, "").split("-");
              const start = parseInt(parts[0], 10);
              const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

              const chunksize = (end - start) + 1;
              const file = fs.createReadStream(videoClipPath, { start, end });

              const sendVideo = async () => {
                return new Promise<void>((resolve, reject) => {
                  try {
                    response.sendStream((async function* () {
                      for await (const chunk of file) {
                        yield chunk;
                      }
                    })(), {
                      code: 206,
                      headers: {
                        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunksize,
                        'Content-Type': 'video/mp4',
                      }
                    });

                    resolve();
                  } catch (err) {
                    reject(err);
                  }
                });
              };

              try {
                await sendVideo();
                return;
              } catch (e) {
                devConsole.log('Error fetching videoclip', e);
              }
            } else {
              response.sendFile(videoClipPath, {
                code: 200,
                headers: {
                  'Content-Length': fileSize,
                  'Content-Type': 'video/mp4',
                }
              });
            }

            return;
          } else if (webhook === 'videoclipThumbnail') {
            devConsole.debug(`Thumbnail requested: ${JSON.stringify({
              filename,
              deviceId,
            })}`);
            const mo = await dev.getVideoClipThumbnail(filename);
            const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
            // const { thumbnailPath } = dev.getStorageDirs({ videoClipNameSrc: filename });

            // const jpeg = await fs.promises.readFile(thumbnailPath);

            response.send(jpeg, {
              headers: {
                'Content-Type': 'image/jpeg',
              }
            });
            return;
          } else if (webhook === 'deleteVideoclip') {
            devConsole.log(`Deleting videoclip via webhook: ${filename}`);
            await dev.removeVideoClips(filename);
            await dev.indexFs();

            response.send('OK', { code: 200 });
            return;
          }
        }
      } catch (e) {
        logger.log(`Error in webhook`, e);
        response.send(`${JSON.stringify(e)}, ${e.message}`, {
          code: 400,
        });

        return;
      }

      response.send(`Webhook not found: ${url.pathname}`, {
        code: 404,
      });

      return;
    } catch (e) {
      this.console.log('Error in data parsing for webhook', e);
      response.send(`Error in data parsing for webhook: ${JSON.stringify({
        params,
        url: request.url
      })}`, {
        code: 500,
      });
    }
  }

  async getSettings(): Promise<Setting[]> {
    const settings: Setting[] = await super.getSettings();

    return settings;
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
    if (
      (
        type === ScryptedDeviceType.Camera ||
        type === ScryptedDeviceType.Doorbell
      ) &&
      (
        interfaces.includes(ScryptedInterface.ObjectDetector)
      )
    ) {
      const ret: string[] = [
        ScryptedInterface.VideoClips,
        ScryptedInterface.EventRecorder,
        // ScryptedInterface.VideoRecorder,
        ScryptedInterface.Settings,
      ];

      return ret;
    }
  }

  async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState) {
    try {
      const ret = new EventsRecorderMixin(
        this,
        mixinDevice,
        mixinDeviceInterfaces,
        mixinDeviceState,
        this.nativeId,
        'Events recorder',
        'eventsRecorder'
      );

      this.currentMixins.add(ret);
      return ret;
    } catch (e) {
      this.getLogger().log('Error on getMixin', e);
    }
  }

  async releaseMixin(id: string, mixinDevice: EventsRecorderMixin) {
    this.currentMixins.delete(mixinDevice);
    return mixinDevice?.release();
  }
}

export default EventsRecorderPlugin;
