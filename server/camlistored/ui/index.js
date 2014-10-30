/*
Copyright 2014 The Camlistore Authors

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

goog.provide('cam.IndexPage');

goog.require('goog.array');
goog.require('goog.dom');
goog.require('goog.dom.classlist');
goog.require('goog.events.EventHandler');
goog.require('goog.labs.Promise');
goog.require('goog.object');
goog.require('goog.string');
goog.require('goog.Uri');

goog.require('cam.BlobDetail');
goog.require('cam.BlobItemContainerReact');
goog.require('cam.BlobItemDemoContent');
goog.require('cam.BlobItemFoursquareContent');
goog.require('cam.BlobItemGenericContent');
goog.require('cam.BlobItemImageContent');
goog.require('cam.BlobItemTwitterContent');
goog.require('cam.BlobItemVideoContent');
goog.require('cam.blobref');
goog.require('cam.DetailView');
goog.require('cam.Dialog');
goog.require('cam.DirectoryDetail');
goog.require('cam.Header');
goog.require('cam.Navigator');
goog.require('cam.PermanodeDetail');
goog.require('cam.permanodeUtils');
goog.require('cam.reactUtil');
goog.require('cam.SearchSession');
goog.require('cam.ServerConnection');
goog.require('cam.TagsControl');

cam.IndexPage = React.createClass({
	displayName: 'IndexPage',

	HEADER_HEIGHT_: 38,
	SEARCH_PREFIX_: {
		RAW: 'raw'
	},
	THUMBNAIL_SIZE_: 200,

	SEARCH_SESSION_CACHE_SIZE_: 3,

	// Note that these are ordered by priority.
	BLOB_ITEM_HANDLERS_: [
		cam.BlobItemDemoContent.getHandler,
		cam.BlobItemFoursquareContent.getHandler,
		cam.BlobItemTwitterContent.getHandler,
		cam.BlobItemImageContent.getHandler,
		cam.BlobItemVideoContent.getHandler,
		cam.BlobItemGenericContent.getHandler
	],

	BLOBREF_PATTERN_: new RegExp('^' + cam.blobref.PATTERN + '$'),

	propTypes: {
		availWidth: React.PropTypes.number.isRequired,
		availHeight: React.PropTypes.number.isRequired,
		config: React.PropTypes.object.isRequired,
		eventTarget: React.PropTypes.shape({addEventListener:React.PropTypes.func.isRequired}).isRequired,
		history: React.PropTypes.shape({pushState:React.PropTypes.func.isRequired, replaceState:React.PropTypes.func.isRequired, go:React.PropTypes.func.isRequired, state:React.PropTypes.object}).isRequired,
		location: React.PropTypes.shape({href:React.PropTypes.string.isRequired, reload:React.PropTypes.func.isRequired}).isRequired,
		scrolling: cam.BlobItemContainerReact.originalSpec.propTypes.scrolling,
		serverConnection: React.PropTypes.instanceOf(cam.ServerConnection).isRequired,
		timer: cam.Header.originalSpec.propTypes.timer,
	},

	componentWillMount: function() {
		this.baseURL_ = null;
		this.currentSet_ = null;
		this.dragEndTimer_ = 0;
		this.navigator_ = null;
		this.searchSessionCache_ = [];
		this.targetSearchSession_ = null;
		this.childSearchSession_ = null;

		this.eh_ = new goog.events.EventHandler(this);

		var newURL = new goog.Uri(this.props.location.href);
		this.baseURL_ = newURL.resolve(new goog.Uri(this.props.config.uiRoot));

		this.navigator_ = new cam.Navigator(this.props.eventTarget, this.props.location, this.props.history);
		this.navigator_.onNavigate = this.handleNavigate_;

		this.handleNavigate_(newURL);
	},

	componentDidMount: function() {
		// TODO(aa): This supports some of the old iframed pages. We can remove it once they are dead.
		goog.global.getSearchSession = function() {
			return this.childSearchSession_;
		}.bind(this);
		this.eh_.listen(this.props.eventTarget, 'keypress', this.handleKeyPress_);
	},

	componentWillUnmount: function() {
		this.eh_.dispose();
		this.clearDragTimer_();
	},

	getInitialState: function() {
		return {
			currentURL: null,
			selection: {},
			serverStatus: null,
			tagsControlVisible: false,

			uploadDialogVisible: false,
			dropActive: false,
			numUploadsTotal: 0,
			numUploadsComplete: 0,
		};
	},

	render: function() {
		var aspects = this.getAspects_();
		var selectedAspect = goog.array.findIndex(aspects, function(v) {
			return v.fragment == this.state.currentURL.getFragment();
		}, this);

		if (selectedAspect == -1) {
			selectedAspect = 0;
		}

		var backwardPiggy = false;
		var contentSize = new goog.math.Size(this.props.availWidth, this.props.availHeight - this.HEADER_HEIGHT_);
		return React.DOM.div({onDragEnter:this.handleDragStart_, onDragOver:this.handleDragStart_, onDrop:this.handleDrop_}, [
			this.getHeader_(aspects, selectedAspect),
			this.getTagsControl_(),
			React.DOM.div(
				{
					className: 'cam-content-wrap',
					style: {
						top: this.HEADER_HEIGHT_,
					},
				},
				aspects[selectedAspect] && aspects[selectedAspect].createContent(contentSize, backwardPiggy)
			),
			this.getUploadDialog_(),
		]);
	},

	setSelection_: function(selection) {
		this.setState({selection: selection});

		// leave contextual controls open if items are still selected
		if (goog.object.isEmpty(selection)) {
			this.setState({tagsControlVisible: false});
		}
	},

	getTargetBlobref_: function(opt_url) {
		var url = opt_url || this.state.currentURL;
		var suffix = url.getPath().substr(this.baseURL_.getPath().length);

		// TODO(aa): Need to implement something like ref.go that knows about the other hash types.
		var match = suffix.match(this.BLOBREF_PATTERN_);
		return match && match[0];
	},

	getAspects_: function() {
		var childFrameClickHandler = this.navigator_.navigate.bind(this.navigator_);
		return [
			this.getSearchAspect_,
			cam.ImageDetail.getAspect,
			cam.PermanodeDetail.getAspect.bind(null, this.props.serverConnection, this.props.timer),
			cam.DirectoryDetail.getAspect.bind(null, this.baseURL_, childFrameClickHandler),
			cam.BlobDetail.getAspect.bind(null, this.getDetailURL_, this.props.serverConnection),
		].map(function(f) {
			return f(this.getTargetBlobref_(), this.targetSearchSession_);
		}, this).filter(goog.functions.identity);
	},

	getSearchAspect_: function(blobref, targetSearchSession) {
		if (blobref) {
			var m = targetSearchSession.getMeta(blobref);
			if (!m || !m.permanode) {
				// We have a target, but it's not a permanode. So don't show the contents view.
				// TODO(aa): Maybe we do want to for directories though?
				return null;
			}

			// This is a hard case: if we're looking at a permanode and it doesn't have any children, should we render a contents view or not?
			//
			// If we do render a contents view, then we have this stupid empty contents view for lots of permanodes types that will probably never have children, like images, tweets, or foursquare checkins.
			//
			// If we don't render a contents view, then permanodes that are meant to actually be sets, but are currently empty won't have a contents view to drag items on to. And when you delete the last item from a set, the contents view will disappear.
			//
			// I'm not sure what the right long term solution is, but not showing a contents view in this case seems less crappy for now.
			//
			// TODO(aa): This relies on the fact that the target search session currently returns attributes, even though that is inefficient and we ideally wouldn't want it to. See bug 435 for details.
			// If we didn't want to rely on this, we'd have to wait for the child search session to come back to know whether we should show this aspect, which is fine, except it causes the UI to stutter -- initially we show no container aspect, then change our mind and show it.
			// Ideally, I think the target search session should just include whether there are any children at all. We don't need to know their details in the target search session, but we do need to know whether any exist for optimal UI.
			if (!cam.permanodeUtils.isContainer(m.permanode)) {
				return null;
			}
		}

		// This can happen when a user types a raw (JSON) query that is invalid.
		if (!this.childSearchSession_) {
			return null;
		}

		return {
			title: blobref ? 'Contents' : 'Search',
			fragment: blobref ? 'contents': 'search',
			createContent: this.getBlobItemContainer_.bind(this),
		};
	},

	handleDragStart_: function(e) {
		this.clearDragTimer_();
		e.preventDefault();
		this.dragEndTimer_ = window.setTimeout(this.handleDragStop_, 2000);
		this.setState({
			dropActive: true,
			uploadDialogVisible: false,
		});
	},

	handleDragStop_: function() {
		this.clearDragTimer_();
		this.setState({dropActive: false});
	},

	clearDragTimer_: function() {
		if (this.dragEndTimer_) {
			window.clearTimeout(this.dragEndTimer_);
			this.dragEndTimer_ = 0;
		}
	},

	handleDrop_: function(e) {
		if (!e.nativeEvent.dataTransfer.files) {
			return;
		}

		e.preventDefault();

		var files = e.nativeEvent.dataTransfer.files;
		var sc = this.props.serverConnection;

		this.setState({
			dropActive: false,
			numUploadsTotal: files.length,
			numUploadsComplete: 0,
		});

		console.log('Uploading %d files...', this.state.numUploadsTotal);
		goog.labs.Promise.all(Array.prototype.map.call(files, function(file) {
			var upload = new goog.labs.Promise(sc.uploadFile.bind(sc, file));
			var createPermanode = new goog.labs.Promise(sc.createPermanode.bind(sc));
			return goog.labs.Promise.all([upload, createPermanode]).then(function(results) {
				// TODO(aa): Icky manual destructuring of results. Seems like there must be a better way?
				var fileRef = results[0];
				var permanodeRef = results[1];
				return new goog.labs.Promise(sc.newSetAttributeClaim.bind(sc, permanodeRef, 'camliContent', fileRef));
			}).thenCatch(function(e) {
				console.error('File upload fall down go boom. file: %s, error: %s', file.name, e);
			}).then(function() {
				console.log('%d of %d files complete.', this.state.numUploadsComplete, this.state.numUploadsTotal);
				this.setState({
					numUploadsComplete: this.state.numUploadsComplete + 1,
				});
			}.bind(this));
		}.bind(this))).then(function() {
			console.log('All complete');
			this.setState({
				numUploadsComplete: 0,
				numUploadsTotal: 0,
			});
		}.bind(this));
	},

	handleNavigate_: function(newURL) {
		if (!goog.string.startsWith(newURL.toString(), this.baseURL_.toString())) {
			return false;
		}

		var targetBlobref = this.getTargetBlobref_(newURL);
		this.updateTargetSearchSession_(targetBlobref);
		this.updateChildSearchSession_(targetBlobref, newURL);
		this.pruneSearchSessionCache_();
		this.setState({currentURL: newURL});
		this.setSelection_({});
		return true;
	},

	updateTargetSearchSession_: function(targetBlobref) {
		if (targetBlobref) {
			this.targetSearchSession_ = this.getSearchSession_(targetBlobref, {blobRefPrefix: targetBlobref});
		} else {
			this.targetSearchSession_ = null;
		}
	},

	updateChildSearchSession_: function(targetBlobref, newURL) {
		var query = newURL.getParameterValue('q');

		if (targetBlobref) {
			query = {
				permanode: {
					relation: {
						relation: 'parent',
						any: { blobRefPrefix: targetBlobref },
					},
				},
			};
		} else if (query) {
			// TODO(aa): Remove this when the server can do something like the 'raw' operator.
			if (goog.string.startsWith(query, this.SEARCH_PREFIX_.RAW + ':')) {
				try {
					query = JSON.parse(query.substring(this.SEARCH_PREFIX_.RAW.length + 1));
				} catch (e) {
					console.error('Raw search is invalid JSON', e);
					query = null;
				}
			}
		} else {
			query = ' ';
		}

		if (query) {
			this.childSearchSession_ = this.getSearchSession_(null, query);
		} else {
			this.childSearchSession_ = null;
		}
	},

	getSearchSession_: function(targetBlobref, query) {
		// This whole business of reusing search session relies on the assumption that we use the same describe rules for both detail queries and search queries.
		var queryString = JSON.stringify(query);
		var cached = goog.array.findIndex(this.searchSessionCache_, function(ss, index) {
			if (targetBlobref && ss.getMeta(targetBlobref)) {
				console.log('Found existing SearchSession for blobref %s at position %d', targetBlobref, index);
				return true;
			} else if (JSON.stringify(ss.getQuery()) == queryString) {
				console.log('Found existing SearchSession for query %s at position %d', queryString, index);
				return true;
			} else {
				return false;
			}
		});

		if (cached > -1) {
			this.searchSessionCache_.splice(0, 0, this.searchSessionCache_.splice(cached, 1)[0]);
			return this.searchSessionCache_[0];
		}

		console.log('Creating new search session for query %s', queryString);
		var ss = new cam.SearchSession(this.props.serverConnection, this.baseURL_.clone(), query);
		this.eh_.listen(ss, cam.SearchSession.SEARCH_SESSION_CHANGED, function() {
			this.forceUpdate();
		});
		this.eh_.listen(ss, cam.SearchSession.SEARCH_SESSION_STATUS, function(e) {
			this.setState({
				serverStatus: e.status,
			});
		});
		this.eh_.listen(ss, cam.SearchSession.SEARCH_SESSION_ERROR, function() {
			this.forceUpdate();
		});
		ss.loadMoreResults();
		this.searchSessionCache_.splice(0, 0, ss);
		return ss;
	},

	pruneSearchSessionCache_: function() {
		for (var i = this.SEARCH_SESSION_CACHE_SIZE_; i < this.searchSessionCache_.length; i++) {
			this.searchSessionCache_[i].close();
		}

		this.searchSessionCache_.length = Math.min(this.searchSessionCache_.length, this.SEARCH_SESSION_CACHE_SIZE_);
	},

	getHeader_: function(aspects, selectedAspectIndex) {
		// We don't show the chooser if there's only one thing to choose from.
		if (aspects.length == 1) {
			aspects = [];
		}

		// TODO(aa): It would be cool to normalize the query and single target case, by supporting searches like is:<blobref>, that way we can always show something in the searchbox, even when we're not in a listview.
		var target = this.getTargetBlobref_();
		var query = '';
		if (target) {
			query = 'ref:' + target;
		} else {
			query = this.state.currentURL.getParameterValue('q') || '';
		}

		return cam.Header(
			{
				currentSearch: query,
				errors: this.getErrors_(),
				height: 38,
				homeURL: this.baseURL_,
				importersURL: this.baseURL_.resolve(new goog.Uri(this.props.config.importerRoot)),
				mainControls: aspects.map(function(val, idx) {
					return React.DOM.a(
						{
							className: React.addons.classSet({
								'cam-header-main-control-active': idx == selectedAspectIndex,
							}),
							href: this.state.currentURL.clone().setFragment(val.fragment).toString(),
						},
						val.title
					);
				}, this),
				onUpload: this.handleUpload_,
				onNewPermanode: this.handleCreateSetWithSelection_,
				onSearch: this.setSearch_,
				searchRootsURL: this.getSearchRootsURL_(),
				statusURL: this.baseURL_.resolve(new goog.Uri(this.props.config.statusRoot)),
				ref: 'header',
				subControls: [
					this.getClearSelectionItem_(),
					this.getCreateSetWithSelectionItem_(),
					this.getSelectAsCurrentSetItem_(),
					this.getAddToCurrentSetItem_(),
					this.getDeleteSelectionItem_(),
					this.getTagsControlItem_()
				].filter(function(c) { return c }),
				timer: this.props.timer,
				width: this.props.availWidth,
			}
		)
	},

	handleNewPermanode_: function() {
		this.props.serverConnection.createPermanode(this.getDetailURL_.bind(this));
	},

	getSearchRootsURL_: function() {
		return this.baseURL_.clone().setParameterValue(
			'q',
			this.SEARCH_PREFIX_.RAW + ':' + JSON.stringify({
				permanode: {
					attr: 'camliRoot',
					numValue: {
						min: 1
					}
				}
			})
		);
	},

	handleSelectAsCurrentSet_: function() {
		this.currentSet_ = goog.object.getAnyKey(this.state.selection);
		this.setSelection_({});
	},

	handleAddToSet_: function() {
		this.addMembersToSet_(this.currentSet_, goog.object.getKeys(this.state.selection));
	},

	handleUpload_: function() {
		this.setState({
			uploadDialogVisible: true,
		});
	},

	handleCreateSetWithSelection_: function() {
		var selection = goog.object.getKeys(this.state.selection);
		this.props.serverConnection.createPermanode(function(permanode) {
			this.props.serverConnection.newSetAttributeClaim(permanode, 'title', 'New set', function() {
				this.addMembersToSet_(permanode, selection);
			}.bind(this));
		}.bind(this));
	},

	addMembersToSet_: function(permanode, blobrefs) {
		var numComplete = -1;
		var callback = function() {
			if (++numComplete == blobrefs.length) {
				this.setSelection_({});
				this.refreshIfNecessary_();
			}
		}.bind(this);

		callback();

		blobrefs.forEach(function(br) {
			this.props.serverConnection.newAddAttributeClaim(permanode, 'camliMember', br, callback);
		}.bind(this));
	},

	handleClearSelection_: function() {
		this.setSelection_({});
	},

	handleDeleteSelection_: function() {
		var blobrefs = goog.object.getKeys(this.state.selection);
		var msg = 'Delete';
		if (blobrefs.length > 1) {
			msg += goog.string.subs(' %s items?', blobrefs.length);
		} else {
			msg += ' item?';
		}
		if (!confirm(msg)) {
			return null;
		}

		var numDeleted = 0;
		blobrefs.forEach(function(br) {
			this.props.serverConnection.newDeleteClaim(br, function() {
				if (++numDeleted == blobrefs.length) {
					this.setSelection_({});
					this.refreshIfNecessary_();
				}
			}.bind(this));
		}.bind(this));
	},

	handleKeyPress_: function(e) {
		if (e.target.tagName == 'INPUT' || e.target.tagName == 'TEXTAREA') {
			return;
		}

		switch (String.fromCharCode(e.charCode)) {
			case '/': {
				this.refs['header'].focusSearch();
				e.preventDefault();
				break;
			}

			case '|': {
				window.__debugConsoleClient = {
					getSelectedItems: function() {
						return this.state.selection;
					}.bind(this),
					serverConnection: this.props.serverConnection,
				};
				window.open('debug_console.html', 'debugconsole', 'width=400,height=300');
				break;
			}
		}
	},

	handleDetailURL_: function(blobref) {
		return this.getDetailURL_(blobref);
	},

	getDetailURL_: function(blobref) {
		return this.baseURL_.clone().setPath(this.baseURL_.getPath() + blobref);
	},

	setSearch_: function(query) {
		var searchURL;
		var match = query.match(/^ref:(.+)/);
		if (match) {
			searchURL = this.getDetailURL_(match[1]);
		} else {
			searchURL = this.baseURL_.clone().setParameterValue('q', query);
		}
		this.navigator_.navigate(searchURL);
	},

	getSelectAsCurrentSetItem_: function() {
		if (goog.object.getCount(this.state.selection) != 1) {
			return null;
		}

		var blobref = goog.object.getAnyKey(this.state.selection);
		if (this.childSearchSession_.getMeta(blobref).camliType != 'permanode') {
			return null;
		}

		return React.DOM.button({key:'selectascurrent', onClick:this.handleSelectAsCurrentSet_}, 'Select as current set');
	},

	getAddToCurrentSetItem_: function() {
		if (!this.currentSet_ || !goog.object.getAnyKey(this.state.selection)) {
			return null;
		}
		return React.DOM.button({key:'addtoset', onClick:this.handleAddToSet_}, 'Add to current set');
	},

	getCreateSetWithSelectionItem_: function() {
		var numItems = goog.object.getCount(this.state.selection);
		if (numItems == 0) {
			return null;
		}
		var label = 'Create set';
		if (numItems == 1) {
			label += ' with item';
		} else if (numItems > 1) {
			label += goog.string.subs(' with %s items', numItems);
		}
		return React.DOM.button({key:'createsetwithselection', onClick:this.handleCreateSetWithSelection_}, label);
	},

	getClearSelectionItem_: function() {
		if (!goog.object.getAnyKey(this.state.selection)) {
			return null;
		}
		return React.DOM.button({key:'clearselection', onClick:this.handleClearSelection_}, 'Clear selection');
	},

	getDeleteSelectionItem_: function() {
		if (!goog.object.getAnyKey(this.state.selection)) {
			return null;
		}
		var numItems = goog.object.getCount(this.state.selection);
		var label = 'Delete';
		if (numItems == 1) {
			label += ' selected item';
		} else if (numItems > 1) {
			label += goog.string.subs(' (%s) selected items', numItems);
		}
		// TODO(mpl): better icon in another CL, with Font Awesome.
		return React.DOM.button({key:'deleteselection', onClick:this.handleDeleteSelection_}, label);
	},

	getTagsControl_: function() {
		if (!this.state.tagsControlVisible) {
			return null;
		}

		return cam.TagsControl(
			{
				selectedItems: this.state.selection,
				searchSession: this.childSearchSession_,
				serverConnection: this.props.serverConnection,
				onCloseControl: this.handleTagsControlClose_
			}
		);
	},

	getTagsControlItem_: function() {
		var numItems = goog.object.getCount(this.state.selection);
		if (numItems == 0) {
			return null;
		}

		var label = goog.string.subs('Tag (%s) items', numItems);

		return React.DOM.button({key:'tagselection', onClick:this.handleTagSelection_}, label);
	},

	isUploading_: function() {
		return this.state.numUploadsTotal > 0;
	},

	getUploadDialog_: function() {
		if (!this.state.uploadDialogVisible && !this.state.dropActive && !this.state.numUploadsTotal) {
			return null;
		}

		var piggyWidth = 88;
		var piggyHeight = 62;
		var borderWidth = 18;
		var w = this.props.availWidth * 0.8;
		var h = this.props.availHeight * 0.8;
		var iconProps = {
			key: 'icon',
			sheetWidth: 10,
			spriteWidth: piggyWidth,
			spriteHeight: piggyHeight,
			style: {
				'margin-right': 3,
				position: 'relative',
				display: 'inline-block',
			}
		};

		function getIcon() {
			if (this.isUploading_()) {
				return cam.SpritedAnimation(cam.object.extend(iconProps, {
					numFrames: 48,
					src: 'glitch/npc_piggy__x1_chew_png_1354829433.png',
				}));
			} else if (this.state.dropActive) {
				return cam.SpritedAnimation(cam.object.extend(iconProps, {
					loopDelay: 4000,
					numFrames: 48,
					src: 'glitch/npc_piggy__x1_look_screen_png_1354829434.png',
					startFrame: 6,
				}));
			} else {
				return cam.SpritedImage(cam.object.extend(iconProps, {
					index: 0,
					src: 'glitch/npc_piggy__x1_look_screen_png_1354829434.png',
				}));
			}
		}

		function getText() {
			if (this.isUploading_()) {
				return goog.string.subs('Uploading (%s of %s)...', this.state.numUploadsComplete, this.state.numUploadsTotal);
			} else {
				return 'Drop files here to upload...';
			}
		}

		return cam.Dialog(
			{
				availWidth: this.props.availWidth,
				availHeight: this.props.availHeight,
				width: w,
				height: h,
				borderWidth: borderWidth,
				onClose: this.state.uploadDialogVisible ? this.handleCloseUploadDialog_ : null,
			},
			React.DOM.div(
				{
					className: 'cam-index-upload-dialog',
					style: {
						'line-height': h - borderWidth * 2,
						'text-align': 'center',
						position: 'relative',
						left: -piggyWidth / 2,
					},
				},
				getIcon.call(this),
				getText.call(this)
			)
		);
	},

	handleCloseUploadDialog_: function() {
		this.setState({
			uploadDialogVisible: false,
		});
	},

	handleTagSelection_: function() {
		this.setState({tagsControlVisible: !this.state.tagsControlVisible});
	},

	handleTagsControlClose_: function() {
		this.setState({tagsControlVisible: false});
	},

	handleSelectionChange_: function(newSelection) {
		this.setSelection_(newSelection);
	},

	getBlobItemContainer_: function() {
		return cam.BlobItemContainerReact({
			key: 'blobitemcontainer',
			ref: 'blobItemContainer',
			detailURL: this.handleDetailURL_,
			handlers: this.BLOB_ITEM_HANDLERS_,
			history: this.props.history,
			onSelectionChange: this.handleSelectionChange_,
			scrolling: this.props.scrolling,
			searchSession: this.childSearchSession_,
			selection: this.state.selection,
			style: this.getBlobItemContainerStyle_(),
			thumbnailSize: this.THUMBNAIL_SIZE_,
			translateY: goog.object.getAnyKey(this.state.selection) ? 36 : 0,
		});
	},

	getBlobItemContainerStyle_: function() {
		return {
			left: 0,
			overflowY: this.state.dropActive ? 'hidden' : '',
			position: 'absolute',
			top: 0,
			height: this.props.availHeight - this.HEADER_HEIGHT_,
			width: this.getContentWidth_(),
		};
	},

	getContentWidth_: function() {
		return this.props.availWidth;
	},

	refreshIfNecessary_: function() {
		if (this.targetSearchSession_) {
			this.targetSearchSession_.refreshIfNecessary();
		}
		if (this.childSearchSession_) {
			this.childSearchSession_.refreshIfNecessary();
		}
	},

	getErrors_: function() {
		var errors = (this.state.serverStatus && this.state.serverStatus.errors) || [];
		if ((this.targetSearchSession_ && this.targetSearchSession_.hasSocketError()) ||
			(this.childSearchSession_ && this.childSearchSession_.hasSocketError())) {
			errors.push({
				error: 'WebSocket error - click to reload',
				onClick: this.props.location.reload.bind(this.props.location, true),
			});
		}
		return errors;
	},
});
