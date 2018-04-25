/* global autosize, Handlebars, Marionette, moment, OC, OCA, OCP */

/**
 *
 * @copyright Copyright (c) 2017, Daniel Calviño Sánchez (danxuliu@gmail.com)
 *
 * @license GNU AGPL version 3 or any later version
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

(function(OCA, OC, OCP, Marionette, Handlebars, autosize, moment) {
	'use strict';

	OCA.SpreedMe = OCA.SpreedMe || {};
	OCA.SpreedMe.Views = OCA.SpreedMe.Views || {};

	var TEMPLATE =
		'<ul class="comments">' +
		'</ul>' +
		'<div class="emptycontent"><div class="icon-comment"></div>' +
		'<p>{{emptyResultLabel}}</p></div>' +
		'<div class="loading hidden" style="height: 50px"></div>';

	var ADD_COMMENT_TEMPLATE =
		'<div class="newCommentRow comment">' +
		'    <div class="authorRow">' +
		'        <div class="avatar" data-username="{{actorId}}"></div>' +
		'        {{#if actorId}}' +
		'            <div class="author">{{actorDisplayName}}</div>' +
		'        {{else}}' +
		'            <div class="guest-name"></div>' +
		'        {{/if}}' +
		'    </div>' +
		'    <form class="newCommentForm">' +
		'        <div contentEditable="true" class="message" data-placeholder="{{newMessagePlaceholder}}">{{message}}</div>' +
		'        <input class="submit icon-confirm" type="submit" value="" />' +
		'        <div class="submitLoading icon-loading-small hidden"></div>'+
		'    </form>' +
		'</div>';

	var COMMENT_TEMPLATE =
		'<li class="comment" data-id="{{id}}">' +
		'    <div class="authorRow">' +
		'        <div class="avatar" data-user-id="{{actorId}}" data-displayname="{{actorDisplayName}}"> </div>' +
		'        <div class="author">{{actorDisplayName}}</div>' +
		'        <div class="date has-tooltip{{#if relativeDate}} live-relative-timestamp{{/if}}" data-timestamp="{{timestamp}}" title="{{altDate}}">{{date}}</div>' +
		'    </div>' +
		'    <div class="message">{{{formattedMessage}}}</div>' +
		'</li>';

	var ChatView = Marionette.View.extend({

		className: function() {
			return 'chat' + (this._oldestOnTopLayout? ' oldestOnTopLayout': '');
		},

		ui: {
			'guestName': 'div.guest-name'
		},

		regions: {
			'guestName': '@ui.guestName'
		},

		events: {
			'submit .newCommentForm': '_onSubmitComment',
		},

		initialize: function(options) {
			this._oldestOnTopLayout = ('oldestOnTopLayout' in options)? options.oldestOnTopLayout: true;

			this.listenTo(this.collection, 'reset', this.render);
			this.listenTo(this.collection, 'add', this._onAddModel);

			this._guestNameEditableTextLabel = new OCA.SpreedMe.Views.EditableTextLabel({
				model: this.getOption('guestNameModel'),
				modelAttribute: 'nick',

				extraClassNames: 'guest-name',
				labelTagName: 'p',
				labelPlaceholder: t('spreed', 'You'),
				inputMaxLength: '20',
				inputPlaceholder: t('spreed', 'Name'),
				buttonTitle: t('spreed', 'Rename')
			});

			_.bindAll(this, '_onAutoComplete');
		},

		_initAutoComplete: function($target) {
			var s = this;
			var limit = 20;
			$target.atwho({
				at: '@',
				limit: limit,
				callbacks: {
					remoteFilter: s._onAutoComplete,
					highlighter: function (li) {
						// misuse the highlighter callback to instead of
						// highlighting loads the avatars.
						var $li = $(li);
						$li.find('.avatar').avatar(undefined, 32);
						return $li;
					},
					sorter: function (q, items) { return items; }
				},
				displayTpl: '<li>'
				+ '<span class="avatar-name-wrapper">'
				+ '<div class="avatar" '
				+ 'data-username="${id}"'	// for avatars
				+ ' data-user="${id}"'		// for contactsmenu
				+ ' data-user-display-name="${label}"></div>'
				+ ' <strong>${label}</strong>'
				+ '</span></li>',
				insertTpl: ''
				+ '@${id}',
				searchKey: "label"
			});
		},

		_onAutoComplete: function(query, callback) {
			var self = this;

			if(_.isEmpty(query)) {
				return;
			}
			if(!_.isUndefined(this._autoCompleteRequestTimer)) {
				clearTimeout(this._autoCompleteRequestTimer);
			}
			this._autoCompleteRequestTimer = _.delay(function() {
				if(!_.isUndefined(this._autoCompleteRequestCall)) {
					this._autoCompleteRequestCall.abort();
				}
				this._autoCompleteRequestCall = $.ajax({
					url: OC.linkToOCS('apps/spreed/api/v1/chat', 2) + self.collection.token + '/autocomplete',
					data: {
						search: query
					},
					beforeSend: function (request) {
						request.setRequestHeader('Accept', 'application/json');
					},
					success: function (result) {
						callback(result.ocs.data);
					}
				});
			}.bind(this), 400);
		},

		template: Handlebars.compile(TEMPLATE),
		templateContext: {
			emptyResultLabel: t('spreed', 'No messages yet, start the conversation!')
		},

		addCommentTemplate: function(params) {
			if (!this._addCommentTemplate) {
				this._addCommentTemplate = Handlebars.compile(ADD_COMMENT_TEMPLATE);
			}

			return this._addCommentTemplate(_.extend({
				actorId: OC.getCurrentUser().uid,
				actorDisplayName: OC.getCurrentUser().displayName,
				newMessagePlaceholder: t('spreed', 'New message …'),
				submitText: t('spreed', 'Send')
			}, params));
		},

		commentTemplate: function(params) {
			if (!this._commentTemplate) {
				this._commentTemplate = Handlebars.compile(COMMENT_TEMPLATE);
			}
			return this._commentTemplate(params);
		},

		onBeforeRender: function() {
			this.getRegion('guestName').reset({ preventDestroy: true, allowMissingEl: true });
		},

		onRender: function() {
			delete this._lastAddedMessageModel;

			if (this._oldestOnTopLayout) {
				this.$el.find('.emptycontent').after(this.addCommentTemplate({}));
			} else {
				this.$el.find('.comments').before(this.addCommentTemplate({}));
			}
			this.$el.find('.has-tooltip').tooltip({container: this._tooltipContainer});
			this.$container = this.$el.find('ul.comments');

			if (OC.getCurrentUser().uid) {
				this.$el.find('.avatar').avatar(OC.getCurrentUser().uid, 32, undefined, false, undefined, OC.getCurrentUser().displayName);
			} else {
				this.$el.find('.avatar').imageplaceholder('?', this.getOption('guestNameModel').get('nick'), 128);
				this.$el.find('.avatar').css('background-color', '#b9b9b9');
				this.showChildView('guestName', this._guestNameEditableTextLabel, { replaceElement: true, allowMissingEl: true } );
			}

			this.delegateEvents();
			var $message = this.$el.find('.message');
			$message.blur().focus();
			$message.on('keydown input change', this._onTypeComment);

			/**
			 * Make sure we focus the actual content part not the placeholder.
			 * Firefox is a bit buggy there: https://stackoverflow.com/a/42170494
			 */
			$message.on("keydown click", function(){
				if(!$message.text().trim().length){
					$message.blur().focus();
				}
			});

			this._initAutoComplete($message);

			autosize(this.$el.find('.newCommentRow .message'));
		},

		focusChatInput: function() {
			this.$el.find('.message').blur().focus();
		},

		/**
		 * Set the tooltip container.
		 *
		 * Depending on the parent elements of the chat view the tooltips may
		 * need to be appended to a specific element to be properly shown (due
		 * to how CSS overflows, clipping areas and positioning contexts work).
		 * If no specific container is ever set, or if it is set to "undefined",
		 * the tooltip elements will be appended as siblings of the element for
		 * which they are shown.
		 *
		 * @param {jQuery} tooltipContainer the element to append the tooltip
		 *        elements to
		 */
		setTooltipContainer: function(tooltipContainer) {
			this._tooltipContainer = tooltipContainer;

			// Update tooltips
			this.$el.find('.has-tooltip').tooltip('destroy');
			this.$el.find('.has-tooltip').tooltip({container: this._tooltipContainer});
		},

		_formatItem: function(commentModel) {
			// PHP timestamp is second-based; JavaScript timestamp is
			// millisecond based.
			var timestamp = commentModel.get('timestamp') * 1000,
				relativeDate = moment(timestamp, 'x').diff(moment()) > -86400000;

			var actorDisplayName = commentModel.get('actorDisplayName');
			if (commentModel.get('actorType') === 'guests' &&
				actorDisplayName === null) {
				actorDisplayName = t('spreed', 'Guest');
			}
			if (actorDisplayName == null) {
				actorDisplayName = t('spreed', '[Unknown user name]');
			}

			var formattedMessage = escapeHTML(commentModel.get('message')).replace(/\n/g, '<br/>');
			formattedMessage = OCP.Comments.plainToRich(formattedMessage);
			formattedMessage = OCA.SpreedMe.RichObjectStringParser.parseMessage(
				formattedMessage, commentModel.get('messageParameters'));

			var data = _.extend({}, commentModel.attributes, {
				actorDisplayName: actorDisplayName,
				timestamp: timestamp,
				date: relativeDate ? OC.Util.relativeModifiedDate(timestamp) : OC.Util.formatDate(timestamp, 'LTS'),
				relativeDate: relativeDate,
				altDate: OC.Util.formatDate(timestamp),
				formattedMessage: formattedMessage
			});
			return data;
		},

		_onAddModel: function(model, collection, options) {
			this.$el.find('.emptycontent').toggleClass('hidden', true);

			var scrollToNew = false;
			var scrollBack = false;
			if (this._oldestOnTopLayout) {
				var $newestComment = this.$container.children('.comment').last();
				scrollToNew = $newestComment.length > 0 && $newestComment.position().top < this.$container.outerHeight(true);
			} else {
				var $firstComment = this.$container.children('.comment').first();
				scrollBack = $firstComment.length > 0 && ($firstComment.position().top + $firstComment.outerHeight()) < 0;
			}

			if (scrollBack) {
				var $firstVisibleComment = this.$container.children('.comment').filter(function() {
						return $(this).position().top > 0;
				}).first();
				var firstVisibleCommentTop = Math.round($firstVisibleComment.position().top);
			}

			var $el = $(this.commentTemplate(this._formatItem(model)));
			if (!_.isUndefined(options.at) && collection.length > 1) {
				this.$container.find('li').eq(options.at).before($el);
			} else if (this._oldestOnTopLayout) {
				this.$container.append($el);
			} else {
				this.$container.prepend($el);
			}

			if (this._modelsHaveSameActor(this._lastAddedMessageModel, model) &&
					this._modelsAreTemporaryNear(this._lastAddedMessageModel, model)) {
				if (this._oldestOnTopLayout) {
					$el.addClass('grouped');
				} else {
					$el.next().addClass('grouped');
				}
			}

			// PHP timestamp is second-based; JavaScript timestamp is
			// millisecond based.
			model.set('date', new Date(model.get('timestamp') * 1000));

			if (!this._lastAddedMessageModel || !this._modelsHaveSameDate(this._lastAddedMessageModel, model)) {
				if (this._oldestOnTopLayout) {
					$el.attr('data-date', this._getDateSeparator(model.get('date')));
					$el.addClass('showDate');
				} else if (this._lastAddedMessageModel) {
					$el.next().attr('data-date', this._getDateSeparator(this._lastAddedMessageModel.get('date')));
					$el.next().addClass('showDate');
				}
			}

			// Keeping the model for the last added message is not only
			// practical, but needed, as the models for previous messages are
			// removed from the collection each time a new set of messages is
			// received.
			this._lastAddedMessageModel = model;

			this._postRenderItem(model, $el);

			if (scrollToNew) {
				var newestCommentHiddenHeight = ($newestComment.position().top + $newestComment.outerHeight(true)) - this.$container.outerHeight(true);
				this.$container.scrollTop(this.$container.scrollTop() + newestCommentHiddenHeight + $el.outerHeight(true));
			} else if (scrollBack) {
				var newFirstVisibleCommentTop = Math.round($firstVisibleComment.position().top);

				// It is not enough to just add the outer height of the added
				// element, as the height of other elements could change too
				// (for example, if the previous last message was grouped with
				// the new one).
				this.$container.scrollTop(this.$container.scrollTop() + (newFirstVisibleCommentTop - firstVisibleCommentTop));
			}
		},

		_getDateSeparator: function(timestamp) {
			var date = moment(timestamp, 'x'),
				today = moment(),
				dayOfYear = OC.Util.formatDate(date, 'YYYY-DDD'),
				dayOfYearToday = OC.Util.formatDate(today, 'YYYY-DDD');

			var relativePrefix = '';
			if (dayOfYear === dayOfYearToday) {
				relativePrefix = t('spreed', 'Today');
			} else {
				var yesterday = OC.Util.formatDate(today.subtract(1, 'd'), 'YYYY-DDD');

				if (dayOfYear === yesterday) {
					relativePrefix = t('spreed', 'Yesterday');
				} else {
					relativePrefix = date.fromNow();
				}
			}

			return t('spreed', '{relativeDate}, {absoluteDate}', {
				relativeDate: relativePrefix,
				// 'LL' formats a localized date including day of month, month
				// name and year
				absoluteDate: OC.Util.formatDate(timestamp, 'LL')
			});
		},

		_modelsHaveSameActor: function(model1, model2) {
			if (!model1 || !model2) {
				return false;
			}

			return model1.get('actorId') === model2.get('actorId') &&
				model1.get('actorType') === model2.get('actorType');
		},

		_modelsAreTemporaryNear: function(model1, model2, secondsThreshold) {
			if (!model1 || !model2) {
				return false;
			}

			if (_.isUndefined(secondsThreshold)) {
				secondsThreshold = 120;
			}

			return Math.abs(model1.get('timestamp') - model2.get('timestamp')) <= secondsThreshold;
		},

		_modelsHaveSameDate: function(model1, model2) {
			if (!model1 || !model2) {
				return false;
			}

			return model1.get('date').toDateString() === model2.get('date').toDateString();
		},

		_postRenderItem: function(model, $el) {
			$el.find('.has-tooltip').tooltip({container: this._tooltipContainer});
			$el.find('.avatar').each(function() {
				var $this = $(this);
				if (model.get('actorType') === 'users') {
					$this.avatar($this.data('user-id'), 32, undefined, false, undefined, $this.data('displayname'));
				} else {
					$this.imageplaceholder('?', model.get('actorDisplayName'), 32);
					$this.css('background-color', '#b9b9b9');
				}
			});

			var username = $el.find('.avatar').data('user-id');
			if (OC.getCurrentUser().uid &&
				model.get('actorType') === 'users' &&
				username !== OC.getCurrentUser().uid) {
				$el.find('.authorRow .avatar, .authorRow .author').contactsMenu(
					username, 0, $el.find('.authorRow'));
			}

			var $message = $el.find('.message');
			this._postRenderMessage($message);
		},

		_postRenderMessage: function($el) {
			$el.find('.mention-user').each(function() {
				var $this = $(this);

				var user = $this.data('user');
				if (user !== OC.getCurrentUser().uid) {
					$this.contactsMenu(user, 0, $this);
				}
			});
		},

		_onTypeComment: function(ev) {
			var $field = $(ev.target);
			var $submitButton = $field.data('submitButtonEl');
			if (!$submitButton) {
				$submitButton = $field.closest('form').find('.submit');
				$field.data('submitButtonEl', $submitButton);
			}

			// Submits form with Enter, but Shift+Enter is a new line. If the
			// autocomplete popover is being shown Enter does not submit the
			// form either; it will be handled by At.js which will add the
			// currently selected item to the message.
			if (ev.keyCode === 13 && !ev.shiftKey && !$field.atwho('isSelecting')) {
				$submitButton.click();
				ev.preventDefault();
			}
		},

		_commentBodyHTML2Plain: function($el) {
			var $comment = $el.clone();

			var oldHtml;
			var html = $comment.html();
			do {
				// replace works one by one
				oldHtml = html;
				html = oldHtml.replace("<br>", "\n");	// preserve line breaks
			} while(oldHtml !== html);
			$comment.html(html);

			return $comment.text();
		},

		_onSubmitComment: function(e) {
			var self = this;
			var $form = $(e.target);
			var $submit = $form.find('.submit');
			var $loading = $form.find('.submitLoading');
			var $commentField = $form.find('.message');
			var message = $commentField.text().trim();

			if (!message.length) {
				return false;
			}

			$commentField.prop('contenteditable', false);
			$submit.addClass('hidden');
			$loading.removeClass('hidden');

			message = this._commentBodyHTML2Plain($commentField);
			var data = {
				token: this.collection.token,
				message: message
			};

			if (!OC.getCurrentUser().uid) {
				var guestNick = OCA.SpreedMe.app._localStorageModel.get('nick');
				if (guestNick) {
					data.actorDisplayName = guestNick;
				}
			}

			var comment = new OCA.SpreedMe.Models.ChatMessage(data);
			comment.save({}, {
				success: function(model) {
					self._onSubmitSuccess(model, $form);
				},
				error: function() {
					self._onSubmitError($form);
				}
			});

			return false;
		},

		_onSubmitSuccess: function(model, $form) {
			$form.find('.submit').removeClass('hidden');
			$form.find('.submitLoading').addClass('hidden');
			$form.find('.message').text('').prop('contenteditable', true);

			$form.find('.message').focus();

			// The new message does not need to be explicitly added to the list
			// of messages; it will be automatically fetched from the server
			// thanks to the auto-refresh of the list.
		},

		_onSubmitError: function($form) {
			$form.find('.submit').removeClass('hidden');
			$form.find('.submitLoading').addClass('hidden');
			$form.find('.message').prop('contenteditable', true);

			$form.find('.message').focus();

			OC.Notification.show(t('spreed', 'Error occurred while sending message'), {type: 'error'});
		},

	});

	OCA.SpreedMe.Views.ChatView = ChatView;

})(OCA, OC, OCP, Marionette, Handlebars, autosize, moment);
