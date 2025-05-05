import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { Post, PostService, ConnectionState } from '../services/post.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-post-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './post-list.component.html',
  styleUrls: ['./post-list.component.css']
})
export class PostListComponent implements OnInit, OnDestroy {
  posts: Post[] = [];
  isConnected = false;
  private subscriptions = new Subscription();

  constructor(private postService: PostService) {}

  ngOnInit(): void {
    // Subscribe to posts
    this.subscriptions.add(
      this.postService.posts$.subscribe(posts => {
        this.posts = posts;
      })
    );
    
    // Subscribe to connection status
    this.subscriptions.add(
      this.postService.connectionStatus$.subscribe(status => {
        this.isConnected = status === ConnectionState.CONNECTED;
      })
    );
    
    // Start listening for updates
    this.postService.connectToEventStream();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  likePost(postId: number): void {
    this.postService.likePost(postId).subscribe();
  }
}