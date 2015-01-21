/*
Copyright 2011 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package server

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"camlistore.org/pkg/blob"
	"camlistore.org/pkg/blobserver"
	"camlistore.org/pkg/magic"
	"camlistore.org/pkg/schema"
)

const oneYear = 365 * 86400 * time.Second

type DownloadHandler struct {
	Fetcher   blob.Fetcher
	Cache     blobserver.Storage
	ForceMime string // optional
}

func (dh *DownloadHandler) blobSource() blob.Fetcher {
	return dh.Fetcher // TODO: use dh.Cache
}

func (dh *DownloadHandler) ServeHTTP(rw http.ResponseWriter, req *http.Request, file blob.Ref) {
	if req.Method != "GET" && req.Method != "HEAD" {
		http.Error(rw, "Invalid download method", 400)
		return
	}
	if req.Header.Get("If-Modified-Since") != "" {
		// Immutable, so any copy's a good copy.
		rw.WriteHeader(http.StatusNotModified)
		return
	}

	fr, err := schema.NewFileReader(dh.blobSource(), file)
	if err != nil {
		http.Error(rw, "Can't serve file: "+err.Error(), 500)
		return
	}
	defer fr.Close()

	h := rw.Header()
	h.Set("Content-Length", fmt.Sprintf("%d", fr.Size()))
	h.Set("Expires", time.Now().Add(oneYear).Format(http.TimeFormat))

	mimeType := magic.MIMETypeFromReaderAt(fr)
	if dh.ForceMime != "" {
		mimeType = dh.ForceMime
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	h.Set("Content-Type", mimeType)

	if mimeType == "application/octet-stream" {
		// Chrome seems to silently do nothing on
		// application/octet-stream unless this is set.
		// Maybe it's confused by lack of URL it recognizes
		// along with lack of mime type?
		fileName := fr.FileName()
		if fileName == "" {
			fileName = "file-" + file.String() + ".dat"
		}
		rw.Header().Set("Content-Disposition", "attachment; filename="+fileName)
	}

	if req.Method == "HEAD" && req.FormValue("verifycontents") != "" {
		vbr, ok := blob.Parse(req.FormValue("verifycontents"))
		if !ok {
			return
		}
		hash := vbr.Hash()
		if hash == nil {
			return
		}
		io.Copy(hash, fr) // ignore errors, caught later
		if vbr.HashMatches(hash) {
			rw.Header().Set("X-Camli-Contents", vbr.String())
		}
		return
	}

	http.ServeContent(rw, req, "", time.Now(), fr)
}
