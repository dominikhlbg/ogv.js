(function() {

    var getTimestamp;
    if (window.performance === undefined || window.performance.now === undefined) {
        console.log("window.performance.now is not available; using Date.now() for benchmarking");
        getTimestamp = Date.now;
    } else {
        console.log("window.performance.now is available; using window.performance.now() for benchmarking");
        getTimestamp = window.performance.now.bind(window.performance);
    }

    var devicePixelRatio = window.devicePixelRatio || 1;

    var player;

    /**
     * dictionary -> URL query string params
     */
    function arrayToCgi(params) {
        var components = [];
        for (var key in params) {
            if (params.hasOwnProperty(key)) {
                var pair = encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
                components[components.length] = pair;
            }
        }
        return components.join('&');
    }

    /**
     * Make a call to Commons API over JSONP
     *
     * @param object params
     * @param function(jsonData) callback
     */
    function commonsApi(params, callback) {
        var baseUrl = 'https://commons.wikimedia.org/w/api.php';
        var url = baseUrl + '?&origin=*'; // anonymous CORS
        var payload = arrayToCgi(params) + '&format=json';

        var xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.onreadystatechange = function() {
            if (xhr.readyState == 4) {
                if (xhr.status >= 400) {
                    throw new Error('Unexpected error ' + xhr.status + 'from Commons API');
                }
                var data = JSON.parse(xhr.responseText);
                callback(data);
            }
        };
        xhr.send(payload);
    }


    function getExtension(filename) {
        var matches = filename.match(/\.([^\.]+)$/);
        if (matches) {
            return matches[1].toLowerCase();
        } else {
            throw new Error("uhhhh no extension on " + filename);
        }
    }

    function firstPageInApiResult(data) {
        var pages = data.query.pages;
        for (var id in pages) {
            if (pages.hasOwnProperty(id)) {
                return pages[id];
            }
        }
        throw new Error("waaaah no pages in pages");
    }

    /**
     * Guesstimate the transcoded resource URL from the original.
     *
     * It would be preferable to get this direct from API,
     * filed request as https://bugzilla.wikimedia.org/show_bug.cgi?id=55622
     *
     * @param String url
     * @param number height
     * @param String format
     */
    function transcodeUrl(url, height, format) {
        var matches = url.match(/^(.*)\/(.\/..)\/(.*?)$/),
            baseUrl = matches[1],
            hash = matches[2],
            filename = matches[3],
            sourceMode = document.querySelector('#media-source').value;
        if (sourceMode == 'shortlist') {
            baseUrl = 'https://media-streaming.wmflabs.org';
        }
        if (sourceMode == 'shortlist-cbr') {
            baseUrl = 'https://media-streaming.wmflabs.org/cbr-soft';
        }
        if (sourceMode == 'shortlist-profile1') {
            baseUrl = 'https://media-streaming.wmflabs.org/profile1';
        }
        return baseUrl + '/transcoded/' + hash + '/' + filename + '/' + filename + '.' + height + 'p.' + format;
    }

    /**
     * @param String media
     * @param function({duration}, [{format, title, width, height, url}]) callback
     */
    function findSourcesForMedia(media, callback) {
        commonsApi({
            action: 'query',
            prop: 'imageinfo|transcodestatus',
            titles: media,
            iiprop: 'url|size|mediatype|metadata',
            iiurlwidth: 1280,
            iiurlheight: 720
        }, function(data, err) {

            var sources = [],
                page = firstPageInApiResult(data);
            if (page && ('imageinfo' in page) && 'transcodestatus' in page) {
                // yay
            } else {
                console.log("Skipping missing image data");
                console.log(page);
                return;
            }

            var imageinfo = page.imageinfo[0],
                transcodestatus = page.transcodestatus;

            function findMetadata(name) {
                var meta = imageinfo.metadata;
                for (var i = 0; i < meta.length; i++) {
                    var pair = meta[i];
                    if (pair.name === name) {
                        return pair.value;
                    }
                }
                return undefined;
            }
            var mediaInfo = {
                mediatype: imageinfo.mediatype,
                duration: findMetadata('length') || findMetadata('playtime_seconds'),
                thumburl: imageinfo.thumburl,
                thumbwidth: imageinfo.thumbwidth,
                thumbheight: imageinfo.thumbheight
            };

            // Build an entry for the original media
            var ext = getExtension(imageinfo.url),
                format;
            if (ext == 'ogg') {
                format = 'ogv'; // todo: check video/audioness
            } else if (ext == 'ogv') {
                format = 'ogv';
            } else if (ext == 'oga') {
                // uhhhh.
                format = 'oga';
            } else if (ext == 'webm') {
                format = 'webm';
            } else {
                throw new Error("Unexpected file extension " + ext);
            }
            sources.push({
                key: 'original',
                format: format,
                width: imageinfo.width,
                height: imageinfo.height,
                url: imageinfo.url,
                size: imageinfo.size,
                bitrate: imageinfo.size * 8 / mediaInfo.duration
            });

            // Build entries for the transcodes
            var sourceMode = document.querySelector('#media-source').value;
            if (sourceMode == 'shortlist' || sourceMode == 'shortlist-cbr' || sourceMode == 'shortlist-profile1') {
                var sizes = [160, 240, 360, 480, 720, 1080, 1440, 2160],
                    widths = [284, 426, 640, 854, 1280, 1920, 2560, 3840],
                    formats = ['ogv', 'webm'];
                if (sourceMode == 'shortlist-profile1') {
                    sizes = [160, 240, 360, 480, 720, 1080];
                    formats = ['webm'];
                }
                sizes.forEach(function(size, i) {
                    formats.forEach(function(format) {
                        // fixme: tweak if necessary
                        var width = widths[i],
                            aspect = imageinfo.width / imageinfo.height,
                            height = Math.round(width / aspect);
                        if (width <= imageinfo.width) {
                            sources.push({
                                key: size + 'p.' + format,
                                format: format,
                                width: width,
                                height: height,
                                url: transcodeUrl(imageinfo.url, size, format),
                            });
                        }
                    });
                });
            } else {
                for (var key in transcodestatus) {
                    if (transcodestatus.hasOwnProperty(key)) {
                        var transcode = transcodestatus[key];
                        if (transcode.time_success != '') {
                            var format, height, matches;
                            matches = key.match(/^(\d+)p\.(.*?)$/);
                            if (matches) {
                                var height = parseInt(matches[1]),
                                    format = matches[2],
                                    bitrate = parseFloat(transcode.final_bitrate);
                                if (bitrate == 0) {
                                    // incomplete
                                    continue;
                                }
                                sources.push({
                                    key: key,
                                    format: format,
                                    width: Math.round(imageinfo.width * height / imageinfo.height),
                                    height: height,
                                    url: transcodeUrl(imageinfo.url, height, format),
                                    size: Math.round(bitrate * mediaInfo.duration / 8),
                                    bitrate: bitrate
                                });
                            } else {
                                console.log("unexpected transcode key name: " + key);
                            }
                        }
                    }
                }
            }

            callback(mediaInfo, sources);
        });
    }

    function fetchMediaList(callback) {
        function pad00(n) {
            if (n < 10) {
                return '0' + n;
            } else {
                return '' + n;
            }
        }

        var today = new Date(),
            year = 2016,
            month = 09,
            day = 20; // where we left off in motd.js, @fixme use live info

        var input = '';
        while (true) {
            if ((year > today.getUTCFullYear()) ||
                (year == today.getUTCFullYear() && month > (today.getUTCMonth() + 1)) ||
                (year == today.getUTCFullYear() && month == (today.getUTCMonth() + 1) && day > today.getUTCDate())) {
                break;
            }
            var ymd = year +
                    '-' +
                    pad00(month) +
                    '-' +
                    pad00(day);
            var line = ymd + '|{{Motd/' + ymd + '}}\n';
            input += line;

            day++;
            if (day > 31) {
                day = 1;
                month++;
                if (month > 12) {
                    month = 1;
                    year++;
                }
            }
        }

        commonsApi({
            action: 'expandtemplates',
            text: input
        }, function(data, err) {
            var output = data.expandtemplates['*'],
                lines = output.split('\n');
            lines.forEach(function(line) {
                var bits = line.split('|'),
                    date = bits[0],
                    filename = bits[1];
                if (filename && !filename.match(/\.gif$/i)) {
                    //console.log(filename);
                    motd[date] = filename;
                } else {
                    //console.log('motd update skipping ' + filename);
                }
            });
            callback();
        });
    }

    var container = document.getElementById('player'),
        videoChooser = document.getElementById('video-chooser'),
        selectedTitle = null,
        selectedUrl = null,
        skipAudio = false,
        playerBackend = 'js',
        muted = false,
        startTime = 0,
        autoplay = false;

    var mediaList = document.getElementById('media-list'),
        filter = document.getElementById('filter');

    function getDefault() {
        if (document.location.hash.length > 1) {
            var title;
            playerBackend = 'js';
            document.location.hash.slice(1).split('&').forEach(function(pair) {
                var parts = pair.split('='),
                    name = decodeURIComponent(parts[0]),
                    value = decodeURIComponent(parts[1]);
                skipAudio = false;
                if (name === 'file') {
                    title = value;
                } else if (name === 'search') {
                    filter.value = value;
                } else if (name === 'mute') {
                    muted = (value == '1');
                } else if (name === 'size') {
                    var selector = document.getElementById('video-preferred-size');
                    selector.value = value;
                    preferredKey = value;
                } else if (name == 'audio') {
                    if (value == '0') {
                        skipAudio = true;
                    }
                } else if (name == 'player') {
                    document.getElementById('player-backend').value = value;
                    playerBackend = value;
                } else if (name == 'source') {
                    document.querySelector('#media-source').value = value;
                }
            });
            if (title) {
                return 'File:' + title;
            }
        }

        // classics! soothing noises, no lipsync to worry about
        //return 'File:Jarry_-_Métro_de_Montréal_(640×360).ogv';

        // clean CG imagery, 1080p source, sound effects but no speech
        //return 'File:Caminandes_-_Gran_Dillama_-_Blender_Foundation\'s_new_Open_Movie.webm';

        // video mostly talking heads, 1080p source, speech needs lipsync
        //return 'File:How_Open_Access_Empowered_a_16-Year-Old_to_Make_Cancer_Breakthrough.ogv';

        // video mostly talking heads, 720p source, speech needs lipsync
        //return 'File:¿Qué es Wikipedia?.ogv';

        // long live-action, mix of various types. 720p+ source, speech needs lipsync
        //return 'File:Knowledge_for_Everyone_(no_subtitles).webm';

        // classics! 720p source, mix of gfx and talking heads. speech needs libsync
        return 'File:Curiosity\'s_Seven_Minutes_of_Terror.ogv';
    }

    var chooserState = 0,
        typingSearchTimeout = null,
        lastSearchValue = null;
    function dismissChooser() {
        document.getElementById('media-chooser-stub').className = '';
        document.getElementById('media-chooser').className = '';
    }
    document.getElementById('media-chooser-stub').addEventListener('click', function() {
        dismissChooser();
    });
    document.querySelector('#media-source').addEventListener('change', function() {
        lastSearchValue = null;
        dismissChooser();
        stopVideo();
        setHash();
        showVideo();
        showChooser();
    });
    function showChooser() {
        var sourceMode = document.querySelector('#media-source').value;

        if (typingSearchTimeout) {
            clearTimeout(typingSearchTimeout);
            typingSearchTimeout = null;
        }
        setHash();

        document.getElementById('media-chooser-stub').className = 'active';
        document.getElementById('media-chooser').className = 'active';

        if (lastSearchValue == filter.value) {
            return;
        }
        lastSearchValue = filter.value;
        var filterString = filter.value.toLowerCase().replace(/^\s+/, '').replace(/\s+$/, '');

        function passFilter(title) {
            return filterString == '' || title.toLowerCase().indexOf(filterString) != -1;
        }

        var selection = [],
            frameRates = {},
            descriptions = {};
        
        function processList(shortlist) {
            shortlist.forEach(function(item) {
                var title = item[0],
                    format = item[1],
                    desc = item[2];
                if (passFilter(title) || passFilter(format) || passFilter(desc)) {
                    selection.push(title);
                    var bits = format.split(/p/);
                    frameRates[title] = parseFloat(bits[1]);
                    descriptions[title] = desc;
                }
            });
        }
        if (sourceMode == 'motd') {
            var max = 40, list = [];
            for (var day in motd) {
                if (motd.hasOwnProperty(day)) {
                    var title = motd[day];
                    if (passFilter(title)) {
                        list.push('File:' + motd[day]);
                    }
                }
            }
            selection = list.reverse().slice(0, max);
        } else if (sourceMode == 'blender') {
            processList([
                [
                    "File:Caminandes- Llama Drama - Short Movie.ogv",
                    '1080p24',
                    '3d animation'
                ],
                [
                    "File:Caminandes - Gran Dillama - Blender Foundation's new Open Movie.webm",
                    '1080p24',
                    '3d animated'
                ],
                [
                    "File:Glass Half - 3D animation with OpenGL cartoon rendering.webm",
                    '2160p24',
                    '2d animation'
                ],
                [
                    "File:Tears of Steel in 4k - Official Blender Foundation release.webm",
                    '2160p24',
                    'live action + CG effects'
                ],
                [
                    "File:Cosmos Laundromat - First Cycle - Official Blender Foundation release.webm",
                    '1152p24',
                    '3d animation'
                ],
                [
                    "File:Sintel movie 4K.webm",
                    '2304p24',
                    '3d animation (has 1000fps bug)'
                ],
                [
                    "File:Big Buck Bunny 4K.webm",
                    '2250p60',
                    '3d animation (has 1000fps bug)'
                ],
                [
                    "File:Elephants Dream (2006) 1080p24.webm",
                    '1080p24',
                    '3d animation'
                ]
            ]);
        } else if (sourceMode == 'highfps') {
            processList([
                [
                    "File:Spectator Mode for Job Simulator - a new way to display social VR footage.webm",
                    '1080p60',
                    'VR game footage'
                ],
                [
                    "File:ManifoldGarden BRoll01 E3 V01.webm",
                    '1080p60',
                    'game footage'
                ],
                [
                    "File:Big Buck Bunny 4K.webm",
                    '2250p60',
                    'animation (has 1000fps bug)'
                ],
                [
                    "File:Stugl,aerial video.webm",
                    '1080p60',
                    'aerial drone footage'
                ],
                [
                    "File:A Moment with Astronaut Kjell Lindgren.webm",
                    '1080p59.94',
                    'live action'
                ],
                [
                    "File:Red-tailed Hawk Eating a Rodent 1080p 60fps.ogv",
                    '1080p59.94',
                    'live action'
                ]
            ]);
        } else if (sourceMode == 'shortlist' || sourceMode == 'shortlist-cbr') {
            var shortlist = [
                // Blender movies
                [
                    "File:Caminandes - Gran Dillama - Blender Foundation's new Open Movie.webm",
                    '1080p24',
                    '3d animated'
                ],
                [
                    "File:Glass Half - 3D animation with OpenGL cartoon rendering.webm",
                    '2160p24',
                    'cartoon; some motion spikes'
                ],
                [
                    "File:Tears of Steel in 4k - Official Blender Foundation release.webm",
                    '2160p24',
                    'sci-fi; mix of scene types'
                ],

                // Space stuff
                [
                    "File:Curiosity's Seven Minutes of Terror.ogv",
                    '720p23.98',
                    'live-action with CG elements'
                ],
                [
                    "File:RED 4K Video of Colorful Liquid in Space.webm",
                    '2160p23.98',
                    'UHD, modest motion'
                ],
                [
                    "File:Ultra High Definition Video from the International Space Station (Reel 1).webm",
                    '2160p23.98',
                    'UHD, mix of low and high motion'
                ],
                [
                    "File:Here's to Engineering.webm",
                    '2160p23.98',
                    'UHD, low motion'
                ],

                // Wikipedia stuff
                [
                    "File:Art and Feminism Wikipedia Edit-a-thon, February 1, 2014.webm",
                    '1080p23.98',
                    'low motion with some spikes'
                ],
                [
                    "File:How Open Access Empowered a 16-Year-Old to Make Cancer Breakthrough.ogv",
                    '1080p23.98',
                    'talking heads; modest motion'
                ],
                [
                    "File:Knowledge for Everyone (short cut).webm",
                    '1080p23.98',
                    'mix of scenes'
                ],
                [
                    "File:Share-a-Fact on the Official Wikipedia Android app.webm",
                    '1080p29.97',
                    'short animation, some motion spikes'
                ],
                [
                    "File:Sneak Preview - Wikipedia VisualEditor.webm",
                    '1080p23.98',
                    'modest motion with spikes'
                ],
                [
                    "File:The Impact Of Wikipedia.webm",
                    '1080p23.98',
                    'low motion'
                ],
                [
                    "File:WikiArabia tech meetup in Ramallah 2016.webm",
                    '1080p24',
                    'modest motion'
                ],
                [
                    "File:Wikipedia Edit 2015.webm",
                    '1080p24',
                    'animated, many dupe frames'
                ],
                [
                    "File:Wiki Makes Video Intro 4 26.webm",
                    '720p59.94',
                    'high fps, mix of scenes'
                ],
                [
                    "File:This is the Wikimedia Foundation.webm",
                    '1080p23.98',
                    'mix of scenes'
                ],

                // Misc stuff
                [
                    "File:Tawakkol Karman (English).ogv",
                    '1080p50',
                    'high fps, modest motion'
                ],
                [
                    "File:Eisbach surfen v1.ogv",
                    '1080p30',
                    'high motion'
                ],
                [
                    "File:FEZ trial gameplay HD.webm",
                    '720p30',
                    'animation'
                ],
                [
                    "File:Furcifer pardalis moving eyes.ogv",
                    '1080p24',
                    'low motion'
                ],
                [
                    "File:Red-tailed Hawk Eating a Rodent 1080p 60fps.ogv",
                    '1080p59.94',
                    'high fps, moderate motion'
                ],
                [
                    "File:Snowdonia by drone.webm",
                    '1080p30',
                    'mix of high and low motion scenes'
                ],
                [
                    "File:Stugl,aerial video.webm",
                    '1080p60',
                    'high fps, high motion'
                ]
            ];
            processList(shortlist);
        } else if (sourceMode == 'shortlist-profile1') {
            var shortlist = [
                [
                    "File:Glass Half - 3D animation with OpenGL cartoon rendering.webm",
                    '2160p24',
                    'cartoon; some motion spikes'
                ],
                [
                    "File:Tears of Steel in 4k - Official Blender Foundation release.webm",
                    '2160p24',
                    'sci-fi; mix of scene types'
                ],
                [
                    "File:Knowledge for Everyone (short cut).webm",
                    '1080p23.98',
                    'mix of scenes'
                ],
                [
                    "File:Stugl,aerial video.webm",
                    '1080p60',
                    'high fps, high motion'
                ]
            ];
            processList(shortlist);
        } else {
            throw new Error('unexpected sourceMode');
        }

        mediaList.innerHTML = '';

        if (selection.length == 0) {
            mediaList.appendChild(document.createTextNode('No matches'));
            return;
        }

        chooserState++;
        var state = chooserState;
        commonsApi({
            action: 'query',
            prop: 'imageinfo',
            iiprop: 'url|size',
            iiurlwidth: 128 * devicePixelRatio,
            iiurlheight: 128 * devicePixelRatio,
            titles: selection.join('|')
        }, function(data) {
            if (state == chooserState) {
                var pages = data.query.pages,
                    mediaItems = {};
                for (var pageId in pages) {
                    if (pages.hasOwnProperty(pageId)) {
                        var page = pages[pageId];
                        if (page.imageinfo) {
                            var imageinfo = page.imageinfo[0];
                            mediaItems[page.title] = imageinfo;
                        }
                    }
                }
                selection.forEach(function(title) {
                    var imageinfo = mediaItems[title];
                    if (imageinfo) {
                        var fmt = imageinfo.width + 'x' + imageinfo.height;
                        if (fmt == '0x0') {
                            fmt = 'audio';
                        }
                        if (frameRates[title]) {
                            fmt += ' ';
                            fmt += frameRates[title];
                            fmt += 'fps';
                        }
                        addMediaSelector(title, imageinfo, fmt, descriptions[title]);
                    }
                });
            }
        });
    }
    filter.addEventListener('change', showChooser);
    document.querySelector('#searchform').addEventListener('submit', function(event) {
        event.preventDefault();
        showChooser();
        filter.blur();
    });
    filter.addEventListener('delete', showChooser);
    filter.addEventListener('cut', showChooser);
    filter.addEventListener('paste', showChooser);
    filter.addEventListener('focus', showChooser);
    filter.addEventListener('keydown', function() {
        if (typingSearchTimeout) {
            clearTimeout(typingSearchTimeout);
        }
        typingSearchTimeout = setTimeout(showChooser, 250);
    });

    window.addEventListener('hashchange', function() {
        // Warning: sometimes this triggers when we change it programatically
        // it seems to be normalizing our unicode or something. Fun!
        var oldTitle = selectedTitle,
            oldFilter = filter.value,
            oldSize = preferredKey,
            oldPlayer = playerBackend;
        selectedTitle = getDefault();
        if (oldTitle != selectedTitle || oldSize != preferredKey || oldPlayer != playerBackend) {
            stopVideo();
            startTime = 0;
            autoplay = false;
            showVideo();
        }
        if (oldFilter != filter.value && document.getElementById('media-chooser').className == 'active') {
            showChooser();
        }
    });

    function addMediaSelector(title, imageinfo, format, desc) {
        var item = document.createElement('div'),
            img = document.createElement('img');

        item.className = 'media-item';

        img.className = 'thumb';
        img.src = imageinfo.thumburl;
        img.title = "Play video"
        img.width = imageinfo.thumbwidth / devicePixelRatio;
        img.height = imageinfo.thumbheight / devicePixelRatio;

        var titleDiv = document.createElement('div');
        titleDiv.className = 'title';
        titleDiv.appendChild(document.createTextNode(' ' + title.replace('File:', '').replace(/_/g, ' ')));

        var descDiv = document.createElement('div');
        descDiv.className = 'desc';
        if (format) {
            var formatSpan = document.createElement('span');
            formatSpan.className = 'format';
            formatSpan.appendChild(document.createTextNode(format));
            descDiv.appendChild(formatSpan);
        }
        if (desc) {
            var descSpan = document.createElement('span');
            descSpan.appendChild(document.createTextNode(desc));
            descDiv.appendChild(descSpan);
        }

        item.appendChild(img);
        item.appendChild(titleDiv);
        item.appendChild(descDiv);
        item.addEventListener('click', function() {
            stopVideo();
            startTime = 0;
            autoplay = false;
            selectedTitle = title;
            setHash();
            dismissChooser();
        });

        mediaList.appendChild(item);
    }

    function setHash() {
        var hash = "#file=" + encodeURIComponent(selectedTitle.replace("File:", "").replace(/ /g, '_'));

        if (filter.value != '') {
            hash += '&search=' + encodeURIComponent(filter.value);
        }

        if (muted) {
            hash += '&mute=1';
        }

        if (playerBackend != 'js') {
            hash += '&player=' + encodeURIComponent(playerBackend);
        }

        var sizeKey = document.getElementById('video-preferred-size').value;
        hash += '&size=' + sizeKey;

        var mode = document.getElementById('media-source').value;
        if (mode == 'motd') {
            // nothin
        } else {
            hash += '&source=' + mode;
        }

        document.location.hash = hash;
    }

    var preferredKey = '360p.ogv';
    if (OGVCompat.isSlow()) {
        preferredKey = '160p.ogv';
    }
    var selector = document.getElementById('video-preferred-size');
    selector.value = preferredKey;
    selector.addEventListener('change', function() {
        stopVideo();
        preferredKey = selector.value;
        console.log('changed to ' + preferredKey);
        setHash();
        showVideo();
    });

    document.querySelector('#player-backend').addEventListener('change', function() {
        stopVideo();
        playerBackend = this.value;
        setHash();
        showVideo();
    });


    function showVideo() {
        window.scrollTo(0, 0);
        stopVideo();

        var prettyName = selectedTitle.replace(/_/g, ' ').replace(/^File:/, '');
        document.title = prettyName + ' - ogv.js demo/test';

        var pagelink = document.getElementById('pagelink');
        pagelink.textContent = prettyName;
        pagelink.href = 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(selectedTitle);
        findSourcesForMedia(selectedTitle, function(mediaInfo, sources) {
            console.log('type of file: ' + mediaInfo.mediatype);
            console.log('duration of file: ' + mediaInfo.duration);

            var selector = document.getElementById('video-preferred-size');
            var options = selector.querySelectorAll('option'),
                optionsMap = {};
            for (var i = 0; i < options.length; i++) {
                optionsMap[options[i].value] = options[i];
                options[i].disabled = true;
            }

            // Find the transcoded or original ogv stream for now

            // temporarily disable the smallest transcodes, except on mobiles/iOS
            var minHeight;
            var selected = null,
                original = null,
                oga = null;
            sources.forEach(function(source) {
                if (source.key == 'original' && source.format == 'ogv') {
                    original = source;
                }
                if (source.key == preferredKey) {
                    selected = source;
                }
                if (source.format == 'oga') {
                    oga = source;
                }
                if (optionsMap[source.key]) {
                    if (optionsMap.hasOwnProperty(source.key)) {
                        optionsMap[source.key].disabled = false;
                    }
                }
            });
            if (selected == null) {
                console.log("Try original file");
                selected = original;
            }
            if (selected == null) {
                console.log("Try audio-only .oga transcode");
                selected = oga;
            }
            if (selected == null) {
                throw new Error("No ogv or oga source found.");
            }

            selectedUrl = selected.url;
            console.log("Going to try streaming data from " + selectedUrl);

            if (player) {
                // this should not happen
                stopVideo();
            }
            var maxmem = undefined;
            if (selected.height > 1080) {
                // hack
                maxmem = 1024 * 1024 * 128;
            }
            var debugFilter;
            //debugFilter = /setting a timer|ready to draw frame|decode frame|decoded frame|drew frame/;
            //debugFilter = /drew frame/;
            //debugFilter = /drew frame.*mux: [^0]/;
            //debugFilter = /drew frame.*mux: [^0]|ahead|dropped|delayed/;
            //debugFilter = /drew frame.*mux: [^0]|audio checkin/;
            //debugFilter = /drew frame|dropped|delayed/;
            //debugFilter = /demuxer|stream is at end/;
            //debugFilter = /waiting/;
            debugFilter = /late frame/;
            //debugFilter = /setting a timer/;
            //debugFilter = /ended|ending|end |demuxer/i;
            //debugFilter = /play loop.*(draw|frame)/;
            if (playerBackend == 'js') {
                player = new OGVPlayer({
                    debug: !!debugFilter,
                    debugFilter: debugFilter,
                    memoryLimit: maxmem,
                    enableWebM: true // experimental
                });
            } else if (playerBackend == 'js-cpu') {
                player = new OGVPlayer({
                    debug: !!debugFilter,
                    debugFilter: debugFilter,
                    memoryLimit: maxmem,
                    webGL: false, // force 2d canvas
                    enableWebM: true // experimental
                });
            } else if (playerBackend == 'js-noworker') {
                player = new OGVPlayer({
                    debug: !!debugFilter,
                    debugFilter: debugFilter,
                    memoryLimit: maxmem,
                    worker: false, // experimental
                    enableWebM: true // experimental
                });
            } else if (playerBackend == 'webgl') {
                player = new OGVPlayer({
                    debug: !!debugFilter,
                    debugFilter: debugFilter,
                    memoryLimit: maxmem,
                    forceWebGL: true,
                    enableWebM: true // experimental
                });
            } else if (playerBackend == 'cortado') {
                player = new CortadoPlayer();
                player.durationHint = mediaInfo.duration;
                player.videoWidthHint = selected.width;
                player.videoHeightHint = selected.height;
                player.width = selected.width; // ?
                player.height = selected.height;
            } else if (playerBackend == 'native') {
                player = document.createElement('video');
            } else {
                throw new Error('unknown player backend');
            }


            document.getElementById('video-fps').textContent = '';
            document.getElementById('video-pic-width').textContent = '';
            document.getElementById('video-pic-height').textContent = '';
            document.getElementById('video-jitter').textContent = '';
            document.getElementById('audio-channels').textContent = '';
            document.getElementById('audio-rate').textContent = '';
            document.getElementById('audio-drops').textContent = '';

            player.addEventListener('loadedmetadata', function() {
                // Standard metadata ain't much.
                document.getElementById('video-pic-width').textContent = player.videoWidth;
                document.getElementById('video-pic-height').textContent = player.videoHeight;

                // And grab our custom metadata...
                var fps;
                if (typeof (player.ogvjsVideoFrameRate) === 'number' && player.ogvjsVideoFrameRate > 0) {
                    benchmark.setTargetFPS(player.ogvjsVideoFrameRate);
                    fps = round2(player.ogvjsVideoFrameRate);
                } else {
                    // Native video element doesn't seem to expose frame rate?!
                    benchmark.setTargetFPS(60);
                    fps = '?';
                }
                document.getElementById('video-fps').textContent = fps;

                if (typeof player.ogvjsAudioChannels === 'number') {
                    document.getElementById('audio-channels').textContent = player.ogvjsAudioChannels;
                    document.getElementById('audio-rate').textContent = player.ogvjsAudioSampleRate;
                }
            });

            // There is a 'timeupdate' event on HTMLMediaElement, but it only
            // seems to fire every quarter second. No per-frame callback for
            // native video, sorry!
            player.addEventListener('framecallback', function(info) {
                benchmark.recordPoint(info);
            });

            if (startTime == 0) {
                player.poster = mediaInfo.thumburl;
            }
            player.src = selectedUrl;
            player.muted = muted;
            player.addEventListener('loadedmetadata', function() {
                if (startTime) {
                    player.currentTime = startTime;
                    if (autoplay) {
                        player.play();
                    }
                }
            });

            var container = document.getElementById('player');
            container.insertBefore(player, container.firstChild);

            if (selected.height == 0) {
                player.width = 256; // hack for audio
                player.height = 256;
            }

            controls.init(player);
            benchmark.init(player);
        });
    }

    var selectedTitle = getDefault();
    //showChooser();
    showVideo();
    fetchMediaList(function() {
        console.log('media list updated');
    });

    function stopVideo() {
        if (player) {
            if (player.currentTime) {
                startTime = player.currentTime;
            }
            autoplay = (player.paused === false);
            player.parentElement.removeChild(player);
            player = null;
        }
    }

    function togglePause() {
        if (player.paused) {
            player.play();
        } else {
            player.pause();
        }
    }

    function playVideo() {
        var status = document.getElementById('status-view');
        status.className = 'status-invisible';
        status.textContent = '';

        OGVPlayer.initSharedAudioContext();
        player.load();
        player.play();
    }


    function showStatus(str) {
        status.className = 'status-visible';
        status.textContent = str;
    }

    function errorHandler(event) {
        var str;
        if ('message' in event) {
            str = event.message;
        } else {
            str = "unknown script error";
        }
        showStatus(str);
        console.log(event);
    }
    //window.addEventListener('error', errorHandler);


    window.setInterval(function() {
        if (player) {
            benchmark.update();
        }
    }, 1000);

})();
