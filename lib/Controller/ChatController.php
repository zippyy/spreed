<?php

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

namespace OCA\Spreed\Controller;

use OC\Collaboration\Collaborators\SearchResult;
use OCA\Spreed\Chat\AutoComplete\SearchPlugin;
use OCA\Spreed\Chat\AutoComplete\Sorter;
use OCA\Spreed\Chat\ChatManager;
use OCA\Spreed\Chat\RichMessageHelper;
use OCA\Spreed\Exceptions\ParticipantNotFoundException;
use OCA\Spreed\Exceptions\RoomNotFoundException;
use OCA\Spreed\GuestManager;
use OCA\Spreed\Manager;
use OCA\Spreed\Room;
use OCA\Spreed\TalkSession;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\OCSController;
use OCP\Collaboration\AutoComplete\IManager;
use OCP\Collaboration\Collaborators\ISearchResult;
use OCP\Comments\IComment;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserManager;

class ChatController extends OCSController {

	/** @var string */
	private $userId;

	/** @var IUserManager */
	private $userManager;

	/** @var TalkSession */
	private $session;

	/** @var Manager */
	private $manager;

	/** @var ChatManager */
	private $chatManager;

	/** @var GuestManager */
	private $guestManager;

	/** @var Room */
	protected $room;

	/** @var string[] */
	protected $guestNames;

	/** @var RichMessageHelper */
	private $richMessageHelper;

	/** @var IManager */
	private $autoCompleteManager;

	/** @var SearchPlugin */
	private $searchPlugin;

	/** @var ISearchResult */
	private $searchResult;

	/**
	 * @param string $appName
	 * @param string $UserId
	 * @param IRequest $request
	 * @param IUserManager $userManager
	 * @param TalkSession $session
	 * @param Manager $manager
	 * @param ChatManager $chatManager
	 * @param GuestManager $guestManager
	 * @param RichMessageHelper $richMessageHelper
	 * @param IManager $autoCompleteManager
	 * @param SearchPlugin $searchPlugin
	 * @param SearchResult $searchResult
	 */
	public function __construct($appName,
								$UserId,
								IRequest $request,
								IUserManager $userManager,
								TalkSession $session,
								Manager $manager,
								ChatManager $chatManager,
								GuestManager $guestManager,
								RichMessageHelper $richMessageHelper,
								IManager $autoCompleteManager,
								SearchPlugin $searchPlugin,
								SearchResult $searchResult) {
		parent::__construct($appName, $request);

		$this->userId = $UserId;
		$this->userManager = $userManager;
		$this->session = $session;
		$this->manager = $manager;
		$this->chatManager = $chatManager;
		$this->guestManager = $guestManager;
		$this->richMessageHelper = $richMessageHelper;
		$this->autoCompleteManager = $autoCompleteManager;
		$this->searchPlugin = $searchPlugin;
		$this->searchResult = $searchResult;
	}

	/**
	 * Returns the Room for the current user.
	 *
	 * If the user is currently not joined to a room then the room with the
	 * given token is returned (provided that the current user is a participant
	 * of that room).
	 *
	 * @param string $token the token for the Room.
	 * @return \OCA\Spreed\Room|null the Room, or null if none was found.
	 */
	private function getRoom($token) {
		try {
			$room = $this->manager->getRoomForSession($this->userId, $this->session->getSessionForRoom($token));
		} catch (RoomNotFoundException $exception) {
			if ($this->userId === null) {
				return null;
			}

			// For logged in users we search for rooms where they are real
			// participants.
			try {
				$room = $this->manager->getRoomForParticipantByToken($token, $this->userId);
				$room->getParticipant($this->userId);
			} catch (RoomNotFoundException $exception) {
				return null;
			} catch (ParticipantNotFoundException $exception) {
				return null;
			}
		}

		$this->room = $room;
		return $room;
	}

	/**
	 * @PublicPage
	 *
	 * Sends a new chat message to the given room.
	 *
	 * The author and timestamp are automatically set to the current user/guest
	 * and time.
	 *
	 * @param string $token the room token
	 * @param string $message the message to send
	 * @param string $actorDisplayName for guests
	 * @return DataResponse the status code is "201 Created" if successful, and
	 *         "404 Not found" if the room or session for a guest user was not
	 *         found".
	 */
	public function sendMessage($token, $message, $actorDisplayName = '') {
		$room = $this->getRoom($token);
		if ($room === null) {
			return new DataResponse([], Http::STATUS_NOT_FOUND);
		}

		if ($this->userId === null) {
			$actorType = 'guests';
			$sessionId = $this->session->getSessionForRoom($token);
			// The character limit for actorId is 64, but the spreed-session is
			// 256 characters long, so it has to be hashed to get an ID that
			// fits (except if there is no session, as the actorId should be
			// empty in that case but sha1('') would generate a hash too
			// instead of returning an empty string).
			$actorId = $sessionId ? sha1($sessionId) : '';

			if ($actorId && $actorDisplayName) {
				$this->guestManager->updateName($room, $sessionId, $actorDisplayName);
			}
		} else {
			$actorType = 'users';
			$actorId = $this->userId;
		}

		if (!$actorId) {
			return new DataResponse([], Http::STATUS_NOT_FOUND);
		}

		$creationDateTime = new \DateTime('now', new \DateTimeZone('UTC'));

		$this->chatManager->sendMessage((string) $room->getId(), $actorType, $actorId, $message, $creationDateTime);

		return new DataResponse([], Http::STATUS_CREATED);
	}

	/**
	 * @PublicPage
	 *
	 * Receives chat messages from the given room.
	 *
	 * - Receiving the history ($lookIntoFuture=0):
	 *   The next $limit messages after $lastKnownMessageId will be returned.
	 *   The new $lastKnownMessageId for the follow up query is available as
	 *   `X-Chat-Last-Given` header.
	 *
	 * - Looking into the future ($lookIntoFuture=1):
	 *   If there are currently no messages the response will not be sent
	 *   immediately. Instead, HTTP connection will be kept open waiting for new
	 *   messages to arrive and, when they do, then the response will be sent. The
	 *   connection will not be kept open indefinitely, though; the number of
	 *   seconds to wait for new messages to arrive can be set using the timeout
	 *   parameter; the default timeout is 30 seconds, maximum timeout is 60
	 *   seconds. If the timeout ends a successful but empty response will be
	 *   sent.
	 *   If messages have been returned (status=200) the new $lastKnownMessageId
	 *   for the follow up query is available as `X-Chat-Last-Given` header.
	 *
	 * @param string $token the room token
	 * @param int $lookIntoFuture Polling for new messages (1) or getting the history of the chat (0)
	 * @param int $limit Number of chat messages to receive (100 by default, 200 at most)
	 * @param int $lastKnownMessageId The last known message (serves as offset)
	 * @param int $timeout Number of seconds to wait for new messages (30 by default, 60 at most)
	 * @return DataResponse an array of chat messages, "404 Not found" if the
	 *         room token was not valid or "304 Not modified" if there were no messages;
	 *         each chat message is an array with
	 *         fields 'id', 'token', 'actorType', 'actorId',
	 *         'actorDisplayName', 'timestamp' (in seconds and UTC timezone) and
	 *         'message'.
	 */
	public function receiveMessages($token, $lookIntoFuture, $limit = 100, $lastKnownMessageId = 0, $timeout = 30) {
		$room = $this->getRoom($token);
		if ($room === null) {
			return new DataResponse([], Http::STATUS_NOT_FOUND);
		}
		$limit = min(200, $limit);
		$timeout = min(60, $timeout);

		if ($lookIntoFuture) {
			$currentUser = $this->userManager->get($this->userId);
			$comments = $this->chatManager->waitForNewMessages((string) $room->getId(), $lastKnownMessageId, $limit, $timeout, $currentUser);
		} else {
			$comments = $this->chatManager->getHistory((string) $room->getId(), $lastKnownMessageId, $limit);
		}

		if (empty($comments)) {
			return new DataResponse([], Http::STATUS_NOT_MODIFIED);
		}

		$guestSessions = [];
		foreach ($comments as $comment) {
			if ($comment->getActorType() !== 'guests') {
				continue;
			}

			$guestSessions[] = $comment->getActorId();
		}

		$guestNames = !empty($guestSessions) ? $this->guestManager->getNamesBySessionHashes($guestSessions) : [];
		$response = new DataResponse(array_map(function (IComment $comment) use ($token, $guestNames) {
			$displayName = '';
			if ($comment->getActorType() === 'users') {
				$user = $this->userManager->get($comment->getActorId());
				$displayName = $user instanceof IUser ? $user->getDisplayName() : '';
			} else if ($comment->getActorType() === 'guests' && isset($guestNames[$comment->getActorId()])) {
				$displayName = $guestNames[$comment->getActorId()];
			}

			list($message, $messageParameters) = $this->richMessageHelper->getRichMessage($comment);

			return [
				'id' => $comment->getId(),
				'token' => $token,
				'actorType' => $comment->getActorType(),
				'actorId' => $comment->getActorId(),
				'actorDisplayName' => $displayName,
				'timestamp' => $comment->getCreationDateTime()->getTimestamp(),
				'message' => $message,
				'messageParameters' => $messageParameters,
			];
		}, $comments), Http::STATUS_OK);

		$newLastKnown = end($comments);
		if ($newLastKnown instanceof IComment) {
			$response->addHeader('X-Chat-Last-Given', $newLastKnown->getId());
		}

		return $response;
	}

	/**
	 * @PublicPage
	 *
	 * @param string $token the room token
	 * @param string $search
	 * @param int $limit
	 * @return DataResponse
	 */
	public function autoComplete($token, $search, $limit = 20) {
		$room = $this->getRoom($token);
		if ($room === null) {
			return new DataResponse([], Http::STATUS_NOT_FOUND);
		}

		$this->searchPlugin->setContext([
			'itemType' => 'chat',
			'itemId' => $room->getId(),
			'room' => $room,
		]);
		$this->searchPlugin->search((string) $search, $limit, 0, $this->searchResult);

		$results = $this->searchResult->asArray();
		$exactMatches = $results['exact'];
		unset($results['exact']);
		$results = array_merge_recursive($exactMatches, $results);

		$this->autoCompleteManager->registerSorter(Sorter::class);
		$this->autoCompleteManager->runSorters(['talk_chat_participants'], $results, [
			'itemType' => 'chat',
			'itemId' => $room->getId(),
		]);

		$results = $this->prepareResultArray($results);
		return new DataResponse($results);
	}


	protected function prepareResultArray(array $results) {
		$output = [];
		foreach ($results as $type => $subResult) {
			foreach ($subResult as $result) {
				$output[] = [
					'id' => $result['value']['shareWith'],
					'label' => $result['label'],
					'source' => $type,
				];
			}
		}
		return $output;
	}
}
