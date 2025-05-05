import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, fromEvent, merge, of, timer } from 'rxjs';
import { catchError, debounceTime, map, retry, tap, takeUntil } from 'rxjs/operators';
import { isPlatformBrowser } from '@angular/common';

export interface Post {
  id: number;
  title: string;
  content: string;
  likesCount: number;
  createdAt: string;
  isUpdated?: boolean; // UI flag for highlighting
  lastUpdateTimestamp?: number; // Used for race condition handling
}

export interface PostUpdateEvent {
  post: Post;
  updateType: string;
  timestamp?: number;
}

export enum ConnectionState {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  RECONNECTING = 'reconnecting'
}

@Injectable({
  providedIn: 'root'
})
export class PostService {
  private apiUrl = 'http://localhost:5045/api/Post';
  private postsSubject = new BehaviorSubject<Post[]>([]);
  private updatedPostIds = new Set<number>();
  private eventSource: EventSource | null = null;
  private connectionStatusSubject = new BehaviorSubject<ConnectionState>(ConnectionState.DISCONNECTED);
  private isBrowser: boolean;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private updateQueue: Map<number, PostUpdateEvent> = new Map(); // Queue to handle rapid updates
  private processingUpdates = false;

  posts$ = this.postsSubject.asObservable();
  connectionStatus$ = this.connectionStatusSubject.asObservable();

  constructor(
    private http: HttpClient,
    @Inject(PLATFORM_ID) private platformId: Object
  ) {
    this.isBrowser = isPlatformBrowser(this.platformId);
    
    if (this.isBrowser) {
      this.loadAllPosts();

      // Setup connection monitoring
      merge(
        of(navigator.onLine),
        fromEvent(window, 'online').pipe(map(() => true)),
        fromEvent(window, 'offline').pipe(map(() => false))
      ).pipe(
        debounceTime(300)
      ).subscribe(isOnline => {
        console.log(`Network status changed: ${isOnline ? 'online' : 'offline'}`);
        if (isOnline && !this.eventSource) {
          this.connectToEventStream();
        } else if (!isOnline && this.eventSource) {
          this.disconnectEventStream();
          this.connectionStatusSubject.next(ConnectionState.DISCONNECTED);
        }
      });
    }
  }

  loadAllPosts(): void {
    console.log(`Loading posts from: ${this.apiUrl}`);
    this.http.get<Post[]>(this.apiUrl).pipe(
      retry(3),
      catchError(error => {
        console.error('Error loading posts', error);
        return of([]);
      })
    ).subscribe(posts => {
      // Add timestamp to each post for race condition management
      const postsWithTimestamp = posts.map(post => ({
        ...post,
        lastUpdateTimestamp: Date.now()
      }));
      this.postsSubject.next(postsWithTimestamp);
      console.log(`Loaded ${posts.length} posts`);
    });
  }

  likePost(id: number): Observable<Post> {
    console.log(`Liking post: ${id}`);
    return this.http.post<Post>(`${this.apiUrl}/${id}/like`, {}).pipe(
      tap(updatedPost => {
        // Update the local state optimistically
        const currentPosts = this.postsSubject.value;
        const index = currentPosts.findIndex(p => p.id === id);
        if (index !== -1) {
          const updatedPosts = [...currentPosts];
          updatedPosts[index] = { 
            ...updatedPosts[index], 
            likesCount: updatedPost.likesCount,
            lastUpdateTimestamp: Date.now()
          };
          this.postsSubject.next(updatedPosts);
        }
      }),
      catchError(error => {
        console.error(`Error liking post ${id}`, error);
        // Reload posts to ensure consistency if there was an error
        this.loadAllPosts();
        throw error;
      })
    );
  }

  connectToEventStream(postId?: number): void {
    // Only connect to event stream in browser environment
    if (!this.isBrowser) {
      return;
    }
    
    if (this.eventSource) {
      this.disconnectEventStream();
    }

    // Don't try to reconnect indefinitely
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(`Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      this.connectionStatusSubject.next(ConnectionState.DISCONNECTED);
      return;
    }

    this.connectionStatusSubject.next(
      this.reconnectAttempts > 0 ? ConnectionState.RECONNECTING : ConnectionState.CONNECTING
    );

    const url = postId 
      ? `${this.apiUrl}/subscribe-sse?postId=${postId}`
      : `${this.apiUrl}/subscribe-sse`;
    
    console.log(`Connecting to SSE stream: ${url} (attempt ${this.reconnectAttempts + 1})`);
    
    try {
      this.eventSource = new EventSource(url);
      
      this.eventSource.onopen = () => {
        console.log('SSE connection established');
        this.connectionStatusSubject.next(ConnectionState.CONNECTED);
        this.reconnectAttempts = 0; // Reset reconnect attempts on success
      };
      
      this.eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        this.disconnectEventStream();
        
        // Try to reconnect with exponential backoff
        if (this.isBrowser) {
          this.reconnectAttempts++;
          const backoffTime = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
          console.log(`Will attempt to reconnect in ${backoffTime}ms (attempt ${this.reconnectAttempts})`);
          
          setTimeout(() => this.connectToEventStream(postId), backoffTime);
        }
      };
      
      this.eventSource.onmessage = (event) => {
        try {
          console.log('SSE message received:', event.data);
          const updateEvent: PostUpdateEvent = JSON.parse(event.data);
          updateEvent.timestamp = Date.now();
          
          // Queue the update to handle race conditions
          this.queueUpdate(updateEvent);
        } catch (error) {
          console.error('Error processing update:', error);
        }
      };
    } catch (error) {
      console.error('Error creating EventSource:', error);
      this.connectionStatusSubject.next(ConnectionState.DISCONNECTED);
      
      // Try to reconnect after delay with exponential backoff
      if (this.isBrowser) {
        this.reconnectAttempts++;
        const backoffTime = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
        setTimeout(() => this.connectToEventStream(postId), backoffTime);
      }
    }
  }

  private queueUpdate(updateEvent: PostUpdateEvent): void {
    const postId = updateEvent.post.id;
    const newTimestamp = updateEvent.timestamp || 0; 
    
    // If we already have a queued update for this post, only keep the newer one
    if (!this.updateQueue.has(postId) || 
        (this.updateQueue.get(postId)?.timestamp || 0) < newTimestamp) {
      this.updateQueue.set(postId, updateEvent);
    }
    
    // Process the queue if not already processing
    if (!this.processingUpdates) {
      this.processUpdateQueue();
    }
  }

  private processUpdateQueue(): void {
    this.processingUpdates = true;
    
    if (this.updateQueue.size === 0) {
      this.processingUpdates = false;
      return;
    }
    
    // Get the next update from the queue
    const entries = Array.from(this.updateQueue.entries());
    const [postId, updateEvent] = entries[0];
    this.updateQueue.delete(postId);
    
    // Process the update
    this.handlePostUpdate(updateEvent);
    
    // Continue processing the queue (using setTimeout to avoid blocking UI)
    setTimeout(() => this.processUpdateQueue(), 10);
  }

  private disconnectEventStream(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.connectionStatusSubject.next(ConnectionState.DISCONNECTED);
    }
  }

  private handlePostUpdate(updateEvent: PostUpdateEvent): void {
    const currentPosts = [...this.postsSubject.value];
    const updatedPost = updateEvent.post;
    
    const index = currentPosts.findIndex(p => p.id === updatedPost.id);
    
    // Check for race conditions - only apply update if it's newer than what we have
    if (index !== -1) {
      const existingPost = currentPosts[index];
      const existingTimestamp = existingPost.lastUpdateTimestamp || 0;
      const newTimestamp = updateEvent.timestamp || Date.now();
      
      // Only update if the new data is more recent
      if (newTimestamp >= existingTimestamp) {
        // Update existing post
        currentPosts[index] = { 
          ...updatedPost, 
          isUpdated: true,
          lastUpdateTimestamp: newTimestamp
        };
        
        // Track this post as updated
        this.updatedPostIds.add(updatedPost.id);
      } else {
        console.log(`Ignoring outdated update for post ${updatedPost.id}`);
        return; // Skip this update
      }
    } else {
      // Add new post
      currentPosts.unshift({
        ...updatedPost,
        isUpdated: true,
        lastUpdateTimestamp: updateEvent.timestamp || Date.now()
      });
      
      // Track this post as updated
      this.updatedPostIds.add(updatedPost.id);
    }
    
    // Update posts list
    this.postsSubject.next(currentPosts);
    
    // Clear highlight after delay
    if (this.isBrowser) {
      setTimeout(() => this.clearUpdateHighlight(updatedPost.id), 3000);
    }
  }

  private clearUpdateHighlight(postId: number): void {
    if (this.updatedPostIds.has(postId)) {
      const currentPosts = [...this.postsSubject.value];
      const index = currentPosts.findIndex(p => p.id === postId);
      
      if (index !== -1) {
        currentPosts[index] = { 
          ...currentPosts[index], 
          isUpdated: false 
        };
        this.postsSubject.next(currentPosts);
      }
      
      this.updatedPostIds.delete(postId);
    }
  }
}