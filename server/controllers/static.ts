import * as cors from 'cors'
import * as express from 'express'
import {
  HLS_STREAMING_PLAYLIST_DIRECTORY,
  ROUTE_CACHE_LIFETIME,
  STATIC_DOWNLOAD_PATHS,
  STATIC_MAX_AGE,
  STATIC_PATHS,
  WEBSERVER
} from '../initializers/constants'
import { VideosCaptionCache, VideosPreviewCache } from '../lib/files-cache'
import { cacheRoute } from '../middlewares/cache'
import { asyncMiddleware, videosGetValidator } from '../middlewares'
import { VideoModel } from '../models/video/video'
import { UserModel } from '../models/account/user'
import { VideoCommentModel } from '../models/video/video-comment'
import { HttpNodeinfoDiasporaSoftwareNsSchema20 } from '../../shared/models/nodeinfo'
import { join } from 'path'
import { root } from '../helpers/core-utils'
import { CONFIG } from '../initializers/config'

const packageJSON = require('../../../package.json')
const staticRouter = express.Router()

staticRouter.use(cors())

/*
  Cors is very important to let other servers access torrent and video files
*/

const torrentsPhysicalPath = CONFIG.STORAGE.TORRENTS_DIR
staticRouter.use(
  STATIC_PATHS.TORRENTS,
  cors(),
  express.static(torrentsPhysicalPath, { maxAge: 0 }) // Don't cache because we could regenerate the torrent file
)
staticRouter.use(
  STATIC_DOWNLOAD_PATHS.TORRENTS + ':id-:resolution([0-9]+).torrent',
  asyncMiddleware(videosGetValidator),
  asyncMiddleware(downloadTorrent)
)

// Videos path for webseeding
staticRouter.use(
  STATIC_PATHS.WEBSEED,
  cors(),
  express.static(CONFIG.STORAGE.VIDEOS_DIR, { fallthrough: false }) // 404 because we don't have this video
)
staticRouter.use(
  STATIC_PATHS.REDUNDANCY,
  cors(),
  express.static(CONFIG.STORAGE.REDUNDANCY_DIR, { fallthrough: false }) // 404 because we don't have this video
)

staticRouter.use(
  STATIC_DOWNLOAD_PATHS.VIDEOS + ':id-:resolution([0-9]+).:extension',
  asyncMiddleware(videosGetValidator),
  asyncMiddleware(downloadVideoFile)
)

// HLS
staticRouter.use(
  STATIC_PATHS.STREAMING_PLAYLISTS.HLS,
  cors(),
  express.static(HLS_STREAMING_PLAYLIST_DIRECTORY, { fallthrough: false }) // 404 if the file does not exist
)

// Thumbnails path for express
const thumbnailsPhysicalPath = CONFIG.STORAGE.THUMBNAILS_DIR
staticRouter.use(
  STATIC_PATHS.THUMBNAILS,
  express.static(thumbnailsPhysicalPath, { maxAge: STATIC_MAX_AGE, fallthrough: false }) // 404 if the file does not exist
)

const avatarsPhysicalPath = CONFIG.STORAGE.AVATARS_DIR
staticRouter.use(
  STATIC_PATHS.AVATARS,
  express.static(avatarsPhysicalPath, { maxAge: STATIC_MAX_AGE, fallthrough: false }) // 404 if the file does not exist
)

// We don't have video previews, fetch them from the origin instance
staticRouter.use(
  STATIC_PATHS.PREVIEWS + ':uuid.jpg',
  asyncMiddleware(getPreview)
)

// We don't have video captions, fetch them from the origin instance
staticRouter.use(
  STATIC_PATHS.VIDEO_CAPTIONS + ':videoId-:captionLanguage([a-z]+).vtt',
  asyncMiddleware(getVideoCaption)
)

// robots.txt service
staticRouter.get('/robots.txt',
  asyncMiddleware(cacheRoute(ROUTE_CACHE_LIFETIME.ROBOTS)),
  (_, res: express.Response) => {
    res.type('text/plain')
    return res.send(CONFIG.INSTANCE.ROBOTS)
  }
)

// security.txt service
staticRouter.get('/security.txt',
  (_, res: express.Response) => {
    return res.redirect(301, '/.well-known/security.txt')
  }
)

staticRouter.get('/.well-known/security.txt',
  asyncMiddleware(cacheRoute(ROUTE_CACHE_LIFETIME.SECURITYTXT)),
  (_, res: express.Response) => {
    res.type('text/plain')
    return res.send(CONFIG.INSTANCE.SECURITYTXT + CONFIG.INSTANCE.SECURITYTXT_CONTACT)
  }
)

// nodeinfo service
staticRouter.use('/.well-known/nodeinfo',
  asyncMiddleware(cacheRoute(ROUTE_CACHE_LIFETIME.NODEINFO)),
  (_, res: express.Response) => {
    return res.json({
      links: [
        {
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
          href: WEBSERVER.URL + '/nodeinfo/2.0.json'
        }
      ]
    })
  }
)
staticRouter.use('/nodeinfo/:version.json',
  asyncMiddleware(cacheRoute(ROUTE_CACHE_LIFETIME.NODEINFO)),
  asyncMiddleware(generateNodeinfo)
)

// dnt-policy.txt service (see https://www.eff.org/dnt-policy)
staticRouter.use('/.well-known/dnt-policy.txt',
  asyncMiddleware(cacheRoute(ROUTE_CACHE_LIFETIME.DNT_POLICY)),
  (_, res: express.Response) => {
    res.type('text/plain')

    return res.sendFile(join(root(), 'dist/server/static/dnt-policy/dnt-policy-1.0.txt'))
  }
)

// dnt service (see https://www.w3.org/TR/tracking-dnt/#status-resource)
staticRouter.use('/.well-known/dnt/',
  (_, res: express.Response) => {
    res.json({ tracking: 'N' })
  }
)

staticRouter.use('/.well-known/change-password',
  (_, res: express.Response) => {
    res.redirect('/my-account/settings')
  }
)

staticRouter.use('/.well-known/host-meta',
  (_, res: express.Response) => {
    res.type('application/xml')

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n' +
      `  <Link rel="lrdd" type="application/xrd+xml" template="${WEBSERVER.URL}/.well-known/webfinger?resource={uri}"/>\n` +
      '</XRD>'

    res.send(xml).end()
  }
)

// ---------------------------------------------------------------------------

export {
  staticRouter
}

// ---------------------------------------------------------------------------

async function getPreview (req: express.Request, res: express.Response) {
  const result = await VideosPreviewCache.Instance.getFilePath(req.params.uuid)
  if (!result) return res.sendStatus(404)

  return res.sendFile(result.path, { maxAge: STATIC_MAX_AGE })
}

async function getVideoCaption (req: express.Request, res: express.Response) {
  const result = await VideosCaptionCache.Instance.getFilePath({
    videoId: req.params.videoId,
    language: req.params.captionLanguage
  })
  if (!result) return res.sendStatus(404)

  return res.sendFile(result.path, { maxAge: STATIC_MAX_AGE })
}

async function generateNodeinfo (req: express.Request, res: express.Response, next: express.NextFunction) {
  const { totalVideos } = await VideoModel.getStats()
  const { totalLocalVideoComments } = await VideoCommentModel.getStats()
  const { totalUsers } = await UserModel.getStats()
  let json = {}

  if (req.params.version && (req.params.version === '2.0')) {
    json = {
      version: '2.0',
      software: {
        name: 'peertube',
        version: packageJSON.version
      },
      protocols: [
        'activitypub'
      ],
      services: {
        inbound: [],
        outbound: [
          'atom1.0',
          'rss2.0'
        ]
      },
      openRegistrations: CONFIG.SIGNUP.ENABLED,
      usage: {
        users: {
          total: totalUsers
        },
        localPosts: totalVideos,
        localComments: totalLocalVideoComments
      },
      metadata: {
        taxonomy: {
          postsName: 'Videos'
        },
        nodeName: CONFIG.INSTANCE.NAME,
        nodeDescription: CONFIG.INSTANCE.SHORT_DESCRIPTION
      }
    } as HttpNodeinfoDiasporaSoftwareNsSchema20
    res.contentType('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"')
  } else {
    json = { error: 'Nodeinfo schema version not handled' }
    res.status(404)
  }

  return res.send(json).end()
}

async function downloadTorrent (req: express.Request, res: express.Response, next: express.NextFunction) {
  const { video, videoFile } = getVideoAndFile(req, res)
  if (!videoFile) return res.status(404).end()

  return res.download(video.getTorrentFilePath(videoFile), `${video.name}-${videoFile.resolution}p.torrent`)
}

async function downloadVideoFile (req: express.Request, res: express.Response, next: express.NextFunction) {
  const { video, videoFile } = getVideoAndFile(req, res)
  if (!videoFile) return res.status(404).end()

  return res.download(video.getVideoFilePath(videoFile), `${video.name}-${videoFile.resolution}p${videoFile.extname}`)
}

function getVideoAndFile (req: express.Request, res: express.Response) {
  const resolution = parseInt(req.params.resolution, 10)
  const video = res.locals.video

  const videoFile = video.VideoFiles.find(f => f.resolution === resolution)

  return { video, videoFile }
}
